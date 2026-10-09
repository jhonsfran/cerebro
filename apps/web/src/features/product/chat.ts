import { z } from "zod";

import type { ConversationMessage, ConversationProjection } from "./projection";
import type { ConversationItem, PendingMessage } from "./types";

export type { ConversationMessage } from "./projection";
export type PendingChatMessage = PendingMessage & {
  mode: "follow-up" | "steer" | "replace";
};
export const pendingChatSchema = z.object({
  eventId: z.string(),
  mode: z.enum(["follow-up", "steer", "replace"]).default("follow-up"),
  text: z.string(),
});
export type ConversationViewItem = ConversationItem & {
  operationId?: string;
  approvalState?: string;
  expiresAt?: number;
  arguments?: unknown;
  output?: unknown;
};

export const conversationItems = (
  projection: ConversationProjection | null,
  path: string
): ConversationViewItem[] => {
  if (!projection) {
    return [];
  }
  const { snapshot } = projection;
  const items: ConversationViewItem[] = [];
  for (const message of snapshot.userMessages) {
    items.push({
      cursor: `user:${message.eventId}`,
      eventId: message.eventId,
      text: message.text,
      type: "user",
    });
  }
  for (const run of snapshot.runs) {
    items.push({ cursor: `run:${run.runId}`, run, type: "run" });
  }
  for (const tool of snapshot.tools) {
    items.push({
      arguments: tool.arguments,
      cursor: `tool:${tool.operationId}`,
      name: tool.toolId,
      operationId: tool.operationId,
      output: tool.output,
      runId: tool.runId,
      state: tool.state,
      toolId: tool.toolId,
      type: "tool",
    });
  }
  for (const approval of snapshot.approvals) {
    items.push({
      approvalId: approval.approvalId,
      approvalState: approval.state,
      cursor: `approval:${approval.approvalId}`,
      expiresAt: approval.expiresAt,
      operationId: approval.operationId,
      runId: approval.runId,
      type: "approval",
    });
  }
  const citations = new Map<string, ConversationViewItem>();
  const addCitation = (
    executionId: (typeof snapshot.executions)[number]["executionId"],
    runId: (typeof snapshot.outputs)[number]["runId"],
    citation: (typeof snapshot.outputs)[number]["citations"][number]
  ) => {
    const cursor = `citation:${executionId}:${citation.sourceId}:${citation.sourceVersion}`;
    citations.set(cursor, {
      cursor,
      href: `${path}/sources/${encodeURIComponent(citation.sourceId)}`,
      runId,
      sourceId: citation.sourceId,
      sourceVersion: citation.sourceVersion,
      title: citation.sourceId,
      type: "citation",
    });
  };
  for (const output of snapshot.outputs) {
    items.push({
      cursor: `output:${output.answerId}`,
      runId: output.runId,
      text: output.text,
      type: "output",
    });
    for (const citation of output.citations) {
      addCitation(output.executionId, output.runId, citation);
    }
  }
  for (const update of projection.citations) {
    addCitation(update.executionId, update.runId, update.citation);
  }
  return [...items, ...citations.values()];
};

export const messageText = (message: ConversationMessage): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("");
