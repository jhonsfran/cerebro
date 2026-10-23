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
import type { MetadataTransaction } from "@cerebro/runtime/session-agent";
import { Context, Effect, Layer } from "effect";

import { checkContentDependencies, createMemoryServices } from "../access";
import type { WorkerEnv } from "../bindings";

export const createSourceDependencyStore = (
  storage: DurableObjectStorage,
  sessionId: EventAddress["sessionId"],
  metadata: MetadataTransaction
) => {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS cerebro_content_source (session_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(session_id, source_id))"
  );
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS cerebro_content_tool (session_id TEXT NOT NULL, tool_id TEXT NOT NULL, PRIMARY KEY(session_id, tool_id))"
  );
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS cerebro_content_chat (session_id TEXT NOT NULL, source_session_id TEXT NOT NULL, organization_id TEXT NOT NULL, agent_id TEXT NOT NULL, conversation_id TEXT NOT NULL, PRIMARY KEY(session_id, source_session_id))"
  );
  return {
    addTool: (toolId: string) =>
      metadata(() => {
        storage.sql.exec(
          "INSERT OR IGNORE INTO cerebro_content_tool VALUES (?, ?)",
          sessionId,
          toolId
        );
      }),
    inherit: (
      source: EventAddress,
      toolIds: readonly string[],
      history: boolean
    ): void => {
      storage.sql.exec(
        "INSERT OR IGNORE INTO cerebro_content_source SELECT ?, source_id FROM cerebro_content_source WHERE session_id=?",
        sessionId,
        source.sessionId
      );
      storage.sql.exec(
        "INSERT OR IGNORE INTO cerebro_content_tool SELECT ?, tool_id FROM cerebro_content_tool WHERE session_id=?",
        sessionId,
        source.sessionId
      );
      for (const toolId of toolIds) {
        storage.sql.exec(
          "INSERT OR IGNORE INTO cerebro_content_tool VALUES (?, ?)",
          sessionId,
          toolId
        );
      }
      storage.sql.exec(
        "INSERT OR IGNORE INTO cerebro_content_chat SELECT ?, source_session_id, organization_id, agent_id, conversation_id FROM cerebro_content_chat WHERE session_id=? AND source_session_id<>?",
        sessionId,
        source.sessionId,
        sessionId
      );
      if (history && source.sessionId !== sessionId) {
        storage.sql.exec(
          "INSERT OR IGNORE INTO cerebro_content_chat VALUES (?, ?, ?, ?, ?)",
          sessionId,
          source.sessionId,
          source.organizationId,
          source.agentId,
          source.conversationId
        );
      }
    },
    tools: () =>
      metadata(() =>
        storage.sql
          .exec<{ tool_id: string }>(
            "SELECT tool_id FROM cerebro_content_tool WHERE session_id=? ORDER BY tool_id",
            sessionId
          )
          .toArray()
          .map((row) => id.tool(row.tool_id))
      ),
    history: () =>
      metadata(() =>
        storage.sql
          .exec<{
            source_session_id: string;
            organization_id: string;
            agent_id: string;
            conversation_id: string;
          }>(
            "SELECT * FROM cerebro_content_chat WHERE session_id=? ORDER BY source_session_id",
            sessionId
          )
          .toArray()
          .map((row): EventAddress => ({
            organizationId: id.organization(row.organization_id),
            agentId: id.agent(row.agent_id),
            conversationId: id.conversation(row.conversation_id),
            sessionId: id.session(row.source_session_id),
          }))
      ),
    add: (sourceIds: readonly string[]): Promise<void> =>
      metadata(() => {
        for (const sourceId of sourceIds) {
          storage.sql.exec(
            "INSERT OR IGNORE INTO cerebro_content_source VALUES (?, ?)",
            sessionId,
            sourceId
          );
        }
      }),
    all: () =>
      metadata(() =>
        storage.sql
          .exec<{ source_id: string }>(
            "SELECT source_id FROM cerebro_content_source WHERE session_id=? ORDER BY source_id",
            sessionId
          )
          .toArray()
          .map((row) => id.source(row.source_id))
      ),
  };
};

export const createRuntimeContent = (
  env: WorkerEnv,
  storage: DurableObjectStorage,
  address: EventAddress,
  agent: AgentDefinition,
  authority: AuthorityService,
  metadata: MetadataTransaction
) => {
  const sources = createSourceDependencyStore(
    storage,
    address.sessionId,
    metadata
  );
  const dependencies = async () => ({
    sourceIds: await sources.all(),
    toolIds: await sources.tools(),
  });
  return {
    dependencies,
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
  metadata: MetadataTransaction
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
            metadata
          ),
      });
    })
  );
