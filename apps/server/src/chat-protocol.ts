import { ChannelError } from "@cerebro/channels/types";
import type { ChannelPresentationItem } from "@cerebro/channels/types";
import type { SessionStreamItem } from "@cerebro/contracts";
import { id } from "@cerebro/contracts/identity";
import type { StoredRun } from "@cerebro/runtime/ledger";
import type { ChatProtocolEvent } from "agents/chat";
import type { UIMessage } from "ai";
import { z } from "zod";

export type ConversationChatMessage = UIMessage<
  unknown,
  { "conversation-item": ChannelPresentationItem }
>;

const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value && value.trim().length > 0);
const userMessage = z.strictObject({
  id: identifier,
  parts: z
    .array(z.strictObject({ text: z.string(), type: z.literal("text") }))
    .min(1),
  role: z.literal("user"),
});
const requestBody = z.object({
  clientTools: z.never().optional(),
  messages: z.array(z.unknown()).min(1),
  trigger: z.literal("submit-message").optional(),
});
const chatAcknowledgement = z.object({
  eventId: z.string(),
  runId: z.string(),
  type: z.literal("user"),
});

export const normalizeChatRequest = (
  event: Extract<ChatProtocolEvent, { type: "chat-request" }>,
  history: readonly UIMessage[],
  identity: {
    readonly userId: string;
    readonly conversationId: string;
    readonly authSessionId: string;
  }
): {
  messages: UIMessage[];
  body: {
    userId: string;
    authSessionId: string;
    conversationId: string;
    eventId: string;
    text: string;
  };
} => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(event.init.body ?? "");
  } catch {
    throw new ChannelError(
      422,
      "invalid-input",
      "The chat request must be JSON."
    );
  }
  const body = requestBody.safeParse(decoded);
  const requestId = identifier.safeParse(event.id);
  if (!body.success || !requestId.success || event.init.method !== "POST") {
    throw new ChannelError(
      422,
      "invalid-input",
      "The chat request is invalid."
    );
  }
  const message = userMessage.safeParse(body.data.messages.at(-1));
  if (!message.success) {
    throw new ChannelError(422, "invalid-input", "Submit a user text message.");
  }
  const text = message.data.parts
    .map((part) => part.text)
    .join("")
    .trim();
  if (!text || text.length > 16_000) {
    throw new ChannelError(
      422,
      "invalid-input",
      "The message text is invalid."
    );
  }
  const existing = history.find((prior) => prior.id === message.data.id);
  if (
    existing &&
    (existing.role !== "user" ||
      existing.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim() !== text)
  ) {
    throw new ChannelError(
      409,
      "digest-mismatch",
      "The message ID has different content."
    );
  }
  const canonical: UIMessage = {
    id: message.data.id,
    parts: [{ text, type: "text" }],
    role: "user",
  };
  return {
    body: { ...identity, eventId: canonical.id, text },
    messages: existing ? [...history] : [...history, canonical],
  };
};

export const projectSessionItem = (
  item: SessionStreamItem,
  conversationId: string
): ChannelPresentationItem => {
  const cursor = `session:${item.cursor}`;
  if (item.type === "run") {
    return { cursor, run: item.run, runId: item.run.runId, type: "run" };
  }
  if (item.type === "output") {
    return { ...item, cursor };
  }
  if (item.type === "citation") {
    return {
      cursor,
      dependencies: item.dependencies,
      href: `/api/product/conversations/${encodeURIComponent(conversationId)}/sources/${encodeURIComponent(item.citation.sourceId)}`,
      runId: item.runId,
      sourceId: item.citation.sourceId,
      sourceVersion: item.citation.sourceVersion,
      title: item.citation.sourceUri,
      type: "citation",
    };
  }
  if (item.type === "tool") {
    return { ...item, cursor, name: item.toolId, state: "succeeded" };
  }
  return { ...item, cursor };
};

export const hydrateChatHistory = (
  runs: readonly StoredRun[],
  items: readonly ChannelPresentationItem[]
): ConversationChatMessage[] => {
  const byRun = new Map<string, ChannelPresentationItem[]>();
  for (const item of items) {
    const prior = byRun.get(item.runId);
    if (prior) {
      prior.push(item);
    } else {
      byRun.set(item.runId, [item]);
    }
  }
  const messages: ConversationChatMessage[] = [];
  for (const run of runs.toSorted(
    (first, second) => first.createdAt - second.createdAt
  )) {
    messages.push({
      id: run.eventId,
      parts: [{ text: run.prompt, type: "text" }],
      role: "user",
    });
    const parts: ConversationChatMessage["parts"] = [];
    if (run.output) {
      parts.push({ text: run.output, type: "text" });
    }
    for (const item of byRun.get(run.runId) ?? []) {
      parts.push({
        data: item,
        id: item.cursor,
        type: "data-conversation-item",
      });
    }
    if (parts.length > 0) {
      messages.push({ id: `assistant:${run.runId}`, parts, role: "assistant" });
    }
  }
  return messages;
};

export const reconcileChatHistory = (
  history: readonly UIMessage[],
  runs: readonly StoredRun[],
  items: readonly ChannelPresentationItem[],
  admittedEvents: ReadonlyMap<string, string> = new Map()
): UIMessage[] => {
  const byId = new Map(history.map((message) => [message.id, message]));
  const eventIds = new Map(admittedEvents);
  for (const message of history) {
    for (const part of message.parts) {
      if (part.type === "data-conversation-item" && "data" in part) {
        const acknowledgement = chatAcknowledgement.safeParse(part.data);
        if (acknowledgement.success) {
          const { eventId, runId } = acknowledgement.data;
          if (!eventIds.has(runId)) {
            eventIds.set(runId, eventId);
          }
        }
      }
    }
  }
  const canonicalRuns = runs.map((run) => {
    const eventId = eventIds.get(run.runId);
    if (!eventId || eventId === run.eventId) {
      return run;
    }
    byId.delete(run.eventId);
    return { ...run, eventId: id.event(eventId) };
  });
  const activeAssistantIds = new Set(
    canonicalRuns
      .filter(
        (run) =>
          !["completed", "failed", "cancelled", "unknown-outcome"].includes(
            run.state
          ) && byId.has(run.eventId)
      )
      .map((run) => `assistant:${run.runId}`)
  );
  const messages: UIMessage[] = [];
  for (const message of hydrateChatHistory(canonicalRuns, items)) {
    const existing = byId.get(message.id);
    if (existing) {
      const partIds = new Set(
        existing.parts.flatMap((part) =>
          part.type === "data-conversation-item" && "id" in part
            ? [part.id]
            : []
        )
      );
      const missing = message.parts.filter(
        (part) =>
          part.type === "data-conversation-item" &&
          "id" in part &&
          !partIds.has(part.id)
      );
      messages.push(
        missing.length > 0
          ? { ...existing, parts: [...existing.parts, ...missing] }
          : existing
      );
      byId.delete(message.id);
    } else if (!activeAssistantIds.has(message.id)) {
      messages.push(message);
    }
  }
  messages.push(...byId.values());
  return messages;
};
