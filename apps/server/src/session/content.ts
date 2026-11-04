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
import { createSourceDependencyStore } from "@cerebro/runtime/content-dependency-store";
import type { MetadataTransaction } from "@cerebro/runtime/session-agent";
import { Context, Effect, Layer } from "effect";

import { checkContentDependencies, createMemoryServices } from "../access";
import type { WorkerEnv } from "../bindings";

export const createRuntimeContent = (
  env: WorkerEnv,
  storage: DurableObjectStorage,
  address: EventAddress,
  agent: AgentDefinition,
  authority: AuthorityService,
  metadata: MetadataTransaction,
  bounded = false
) => {
  const sources = createSourceDependencyStore(
    storage,
    address.sessionId,
    metadata,
    bounded
  );
  const dependencies = async () => ({
    sourceIds: await sources.all(),
    toolIds: await sources.tools(),
  });
  return {
    dependencies,
    importDependencies: sources.importDependencies,
    historyDependencies: sources.history,
    inheritDependencies: sources.inherit,
    recordTool: sources.addTool,
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
                sourceIds: agent.grants
                  .filter(
                    (grant) =>
                      grant.action === "read" &&
                      grant.resource.kind === "memory" &&
                      grant.resource.organizationId === address.organizationId
                  )
                  .map((grant) => id.source(grant.resource.id)),
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
        yield* tryAdapter(() => sources.add(requested.sourceIds));
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
  agent: AgentDefinition,
  metadata: MetadataTransaction,
  bounded = false
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
          createRuntimeContent(
            env,
            storage,
            address,
            agent,
            authority,
            metadata,
            bounded
          ),
      });
    })
  );
