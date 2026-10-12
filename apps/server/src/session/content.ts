import { AuthorityService } from "@cerebro/contracts/authority-service";
import type { EventAddress } from "@cerebro/contracts/events";
import {
  Unavailable,
  fromPortResult,
  tryAdapter,
} from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { AgentDefinition } from "@cerebro/contracts/session";
import { withDatabase } from "@cerebro/db";
import { Context, Effect, Layer, Schema } from "effect";

import { checkContentDependencies, createMemoryServices } from "../access";
import type { WorkerEnv } from "../bindings";

const dependenciesSchema = Schema.Struct({
  sourceIds: Schema.Array(Schema.NonEmptyString),
});
const legacyContentSchema = Schema.Struct({ dependencies: dependenciesSchema });
const legacySnapshotSchema = Schema.Struct({
  snapshot: Schema.Struct({
    agentVersion: Schema.Int.check(Schema.isGreaterThan(0)),
    outputs: Schema.Array(legacyContentSchema),
    tools: Schema.Array(legacyContentSchema),
  }),
});

export const migrateLegacySessionMetadata = (
  storage: DurableObjectStorage
): number | undefined => {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS cerebro_content_source (source_id TEXT PRIMARY KEY)"
  );
  const tables = new Set(
    storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cerebro_pi_session', 'cerebro_pi_content')"
      )
      .toArray()
      .map((row) => row.name)
  );
  const sources = new Set<string>();
  let agentVersion: number | undefined;
  if (tables.has("cerebro_pi_session")) {
    const [row] = storage.sql
      .exec<{ state: string }>(
        "SELECT state FROM cerebro_pi_session WHERE id=1"
      )
      .toArray();
    if (row) {
      const { snapshot } = Schema.decodeUnknownSync(legacySnapshotSchema)(
        JSON.parse(row.state)
      );
      ({ agentVersion } = snapshot);
      for (const item of [...snapshot.outputs, ...snapshot.tools]) {
        for (const sourceId of item.dependencies.sourceIds) {
          sources.add(sourceId);
        }
      }
    }
  }
  if (tables.has("cerebro_pi_content")) {
    const rows = storage.sql
      .exec<{ payload: string }>("SELECT payload FROM cerebro_pi_content")
      .toArray();
    for (const row of rows) {
      const content = Schema.decodeUnknownSync(legacyContentSchema)(
        JSON.parse(row.payload)
      );
      for (const sourceId of content.dependencies.sourceIds) {
        sources.add(sourceId);
      }
    }
  }
  for (const sourceId of sources) {
    storage.sql.exec(
      "INSERT OR IGNORE INTO cerebro_content_source VALUES (?)",
      id.source(sourceId)
    );
  }
  return agentVersion;
};

export const createRuntimeContent = (
  env: WorkerEnv,
  storage: DurableObjectStorage,
  address: EventAddress,
  agent: AgentDefinition,
  authority: AuthorityService
) => {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS cerebro_content_source (source_id TEXT PRIMARY KEY)"
  );
  const dependencies = () => ({
    sourceIds: storage.sql
      .exec<{ source_id: string }>(
        "SELECT source_id FROM cerebro_content_source"
      )
      .toArray()
      .map((row) => id.source(row.source_id)),
    toolIds: [],
  });
  return {
    dependencies,
    prepareInput: (text: string, context: ExecutionContext) =>
      Effect.gen(function* prepareCurrentModelInput() {
        const options = { deadlineAt: Date.now() + 10_000 };
        const hits = yield* tryAdapter(() =>
          withDatabase(env, (database) =>
            createMemoryServices(env, database).memory.retrieve(
              {
                context,
                limit: 6,
                organizationId: address.organizationId,
                text,
              },
              options
            )
          )
        ).pipe(Effect.flatMap(fromPortResult));
        const permitted = [];
        for (const hit of hits) {
          const result = yield* Effect.result(
            authority.require(
              {
                action: "read",
                address,
                context,
                pinnedAgent: agent,
                resource: {
                  id: hit.citation.sourceId,
                  kind: "memory",
                  organizationId: address.organizationId,
                },
              },
              options
            )
          );
          if (result._tag === "Success") {
            permitted.push(hit);
          } else if (result.failure._tag !== "Denied") {
            return yield* Effect.fail(result.failure);
          }
        }
        const requested = {
          sourceIds: permitted.map((hit) => hit.citation.sourceId),
          toolIds: [],
        };
        yield* tryAdapter(() =>
          withDatabase(env, (database) =>
            checkContentDependencies(env, database, context, requested, options)
          )
        ).pipe(Effect.flatMap(fromPortResult));
        for (const sourceId of requested.sourceIds) {
          storage.sql.exec(
            "INSERT OR IGNORE INTO cerebro_content_source VALUES (?)",
            sourceId
          );
        }
        yield* tryAdapter(() => storage.sync());
        return permitted.length
          ? `${text}\n\nAuthorized source excerpts:\n${permitted.map((hit) => `${hit.citation.sourceUri} (${hit.citation.sourceVersion}):\n${hit.record.text}`).join("\n\n")}`
          : text;
      }),
  };
};

export const SessionContent = Context.Service<
  ReturnType<typeof createRuntimeContent>
>("cerebro/SessionContent");
export const sessionContentLayer = (
  env: WorkerEnv,
  storage: DurableObjectStorage,
  address: EventAddress,
  agent: AgentDefinition
) =>
  Layer.effect(
    SessionContent,
    Effect.gen(function* currentContent() {
      const authority = yield* AuthorityService;
      return yield* Effect.try({
        catch: () =>
          new Unavailable({
            reason: "Source dependency metadata is unavailable.",
          }),
        try: () =>
          createRuntimeContent(env, storage, address, agent, authority),
      });
    })
  );
