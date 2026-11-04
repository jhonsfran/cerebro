import type { EventAddress } from "@cerebro/contracts/events";
import { id } from "@cerebro/contracts/identity";
import type { ContentDependencies } from "@cerebro/contracts/session";
import { BoundedContentDependenciesSchema } from "@cerebro/contracts/work";
import { Schema } from "effect";

import type { MetadataTransaction } from "./session-agent.ts";

export const createSourceDependencyStore = (
  storage: DurableObjectStorage,
  sessionId: EventAddress["sessionId"],
  metadata: MetadataTransaction,
  bounded = false
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
  const importDependencies = (dependencies: ContentDependencies): void => {
    if (bounded) {
      Schema.decodeUnknownSync(BoundedContentDependenciesSchema)({
        sourceIds: [
          ...new Set([
            ...storage.sql
              .exec<{ source_id: string }>(
                "SELECT source_id FROM cerebro_content_source WHERE session_id=?",
                sessionId
              )
              .toArray()
              .map((row) => row.source_id),
            ...dependencies.sourceIds,
          ]),
        ],
        toolIds: [
          ...new Set([
            ...storage.sql
              .exec<{ tool_id: string }>(
                "SELECT tool_id FROM cerebro_content_tool WHERE session_id=?",
                sessionId
              )
              .toArray()
              .map((row) => row.tool_id),
            ...dependencies.toolIds,
          ]),
        ],
      });
    }
    for (const sourceId of dependencies.sourceIds) {
      storage.sql.exec(
        "INSERT OR IGNORE INTO cerebro_content_source VALUES (?, ?)",
        sessionId,
        sourceId
      );
    }
    for (const toolId of dependencies.toolIds) {
      storage.sql.exec(
        "INSERT OR IGNORE INTO cerebro_content_tool VALUES (?, ?)",
        sessionId,
        toolId
      );
    }
  };
  return {
    importDependencies,
    addTool: (toolId: string) =>
      metadata(() => importDependencies({ sourceIds: [], toolIds: [toolId] })),
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
      metadata(() =>
        importDependencies({ sourceIds: sourceIds.map(id.source), toolIds: [] })
      ),
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
