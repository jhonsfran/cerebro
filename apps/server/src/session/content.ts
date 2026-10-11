import { AuthorityService } from "@cerebro/contracts/authority-service";
import type { EventAddress } from "@cerebro/contracts/events";
import type { DurableHandoff } from "@cerebro/contracts/execution";
import {
  InvalidInput,
  Unavailable,
  fromPortResult,
  tryAdapter,
} from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { AgentDefinition } from "@cerebro/contracts/session";
import { DomainSnapshot } from "@cerebro/contracts/session-service";
import { withDatabase } from "@cerebro/db";
import { Context, Effect, Layer, Schema } from "effect";
import { z } from "zod";

import { checkContentDependencies, createMemoryServices } from "../access";
import type { WorkerEnv } from "../bindings";
import { contextSchema } from "./proof";

const preparedSchema = z.strictObject({
  citations: z.array(
    z.strictObject({
      observedAt: z.number(),
      sourceId: z.string().transform(id.source),
      sourceUri: z.string(),
      sourceVersion: z.string(),
    })
  ),
  context: contextSchema,
  dependencies: z.strictObject({
    sourceIds: z.array(z.string().transform(id.source)),
    toolIds: z.array(z.string()),
  }),
  text: z.string(),
});

export const createRuntimeContent = (
  env: WorkerEnv,
  storage: DurableObjectStorage,
  address: EventAddress,
  agent: AgentDefinition,
  authority: AuthorityService
) => {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS cerebro_pi_content (run_id TEXT PRIMARY KEY, payload TEXT NOT NULL)"
  );
  const read = (runId: string) => {
    const [row] = storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM cerebro_pi_content WHERE run_id=?",
        runId
      )
      .toArray();
    return row ? preparedSchema.parse(JSON.parse(row.payload)) : undefined;
  };
  const toolDependencies = (runId?: string) => {
    const [row] = storage.sql
      .exec<{ state: string }>(
        "SELECT state FROM cerebro_pi_session WHERE id=1"
      )
      .toArray();
    const snapshot = row
      ? Schema.decodeUnknownSync(DomainSnapshot)(JSON.parse(row.state).snapshot)
      : undefined;
    return (
      snapshot?.tools
        .filter((tool) => !runId || tool.runId === runId)
        .flatMap((tool) => tool.dependencies.toolIds) ?? []
    );
  };
  const withTools = (
    prepared: z.infer<typeof preparedSchema>,
    runId: string
  ) => ({
    ...prepared,
    dependencies: {
      ...prepared.dependencies,
      toolIds: [
        ...new Set([
          ...prepared.dependencies.toolIds,
          ...toolDependencies(runId),
        ]),
      ],
    },
  });
  const check = (prepared: z.infer<typeof preparedSchema>) =>
    Effect.gen(function* checkPreparedContent() {
      const options = { deadlineAt: Date.now() + 10_000 };
      for (const sourceId of prepared.dependencies.sourceIds) {
        yield* authority.require(
          {
            action: "read",
            address,
            context: prepared.context,
            pinnedAgent: agent,
            resource: {
              id: sourceId,
              kind: "memory",
              organizationId: address.organizationId,
            },
          },
          options
        );
      }
      yield* tryAdapter(() =>
        withDatabase(env, (database) =>
          checkContentDependencies(
            env,
            database,
            prepared.context,
            prepared.dependencies,
            options
          )
        )
      ).pipe(Effect.flatMap(fromPortResult));
    });
  return {
    beforeFetch: () =>
      Effect.gen(function* checkProviderContext() {
        const rows = storage.sql
          .exec<{ payload: string; run_id: string }>(
            "SELECT run_id, payload FROM cerebro_pi_content"
          )
          .toArray();
        for (const row of rows) {
          yield* check(
            withTools(preparedSchema.parse(JSON.parse(row.payload)), row.run_id)
          );
        }
      }),
    content: (handoff: DurableHandoff) =>
      Effect.gen(function* outputContent() {
        const stored = read(handoff.submission.runId);
        if (!stored) {
          return yield* Effect.fail(
            new InvalidInput({
              reason: "The accepted input content is unavailable.",
            })
          );
        }
        const prepared = withTools(stored, handoff.submission.runId);
        yield* check(prepared);
        return {
          citations: prepared.citations,
          dependencies: prepared.dependencies,
        };
      }),
    dependencies: () => ({
      sourceIds: [
        ...new Set(
          storage.sql
            .exec<{ payload: string }>("SELECT payload FROM cerebro_pi_content")
            .toArray()
            .flatMap(
              (row) =>
                preparedSchema.parse(JSON.parse(row.payload)).dependencies
                  .sourceIds
            )
        ),
      ],
      toolIds: [...new Set(toolDependencies())],
    }),
    prepareInput: (handoff: DurableHandoff) =>
      Effect.gen(function* prepareInput() {
        const prior = read(handoff.submission.runId);
        if (prior) {
          yield* check(prior);
          return prior.text;
        }
        const { event } = handoff.submission.event;
        if (event.type !== "user.message" && event.type !== "scheduled.run") {
          return yield* Effect.fail(
            new InvalidInput({
              reason: "The event cannot prepare model input.",
            })
          );
        }
        const text =
          event.type === "user.message"
            ? event.payload.text
            : event.payload.task;
        const { context } = handoff.submission.event;
        const hits = yield* tryAdapter(() =>
          withDatabase(env, (database) =>
            createMemoryServices(env, database).memory.retrieve(
              {
                context,
                limit: 6,
                organizationId: address.organizationId,
                text,
              },
              { deadlineAt: Date.now() + 10_000 }
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
              { deadlineAt: Date.now() + 10_000 }
            )
          );
          if (result._tag === "Success") {
            permitted.push(hit);
          } else if (result.failure._tag !== "Denied") {
            return yield* Effect.fail(result.failure);
          }
        }
        const prepared = preparedSchema.parse({
          citations: permitted.map((hit) => hit.citation),
          context,
          dependencies: {
            sourceIds: permitted.map((hit) => hit.citation.sourceId),
            toolIds: [],
          },
          text: permitted.length
            ? `${text}\n\nAuthorized source excerpts:\n${permitted.map((hit) => `${hit.citation.sourceUri} (${hit.citation.sourceVersion}):\n${hit.record.text}`).join("\n\n")}`
            : text,
        });
        yield* check(prepared);
        storage.transactionSync(() =>
          storage.sql
            .exec(
              "INSERT INTO cerebro_pi_content VALUES (?, ?)",
              handoff.submission.runId,
              JSON.stringify(prepared)
            )
            .toArray()
        );
        yield* tryAdapter(() => storage.sync());
        return prepared.text;
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
    Effect.gen(function* contentChecks() {
      const authority = yield* AuthorityService;
      return yield* Effect.try({
        catch: () =>
          new Unavailable({ reason: "Durable source context is unavailable." }),
        try: () =>
          createRuntimeContent(env, storage, address, agent, authority),
      });
    })
  );
