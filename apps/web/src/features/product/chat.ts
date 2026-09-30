import { validateUIMessages } from "ai";
import type { UIMessage } from "ai";
import { z } from "zod";

import {
  assertCurrentAccess,
  currentAccessGeneration,
  ProductError,
  request,
} from "./api";
import { conversationItemSchema } from "./types";
import type { ConversationItem } from "./types";

export type ConversationMessage = UIMessage<
  unknown,
  { "conversation-item": ConversationItem }
>;

export const conversationDataSchemas = {
  "conversation-item": conversationItemSchema,
};

export const loadChatMessages = async ({
  url,
}: {
  url?: string;
}): Promise<ConversationMessage[]> => {
  if (!url) {
    return [];
  }
  const generation = currentAccessGeneration();
  const endpoint = new URL(url);
  endpoint.pathname += "/get-messages";
  try {
    const value = await request(
      `${endpoint.pathname}${endpoint.search}`,
      z.unknown()
    );
    if (Array.isArray(value) && value.length === 0) {
      assertCurrentAccess(generation);
      return [];
    }
    const messages = await validateUIMessages<ConversationMessage>({
      dataSchemas: conversationDataSchemas,
      messages: value,
    });
    assertCurrentAccess(generation);
    return messages;
  } catch (error) {
    if (error instanceof ProductError && [401, 403].includes(error.status)) {
      return [];
    }
    throw error;
  }
};

const terminalRunStates = new Set([
  "completed",
  "failed",
  "cancelled",
  "unknown-outcome",
]);

const conversationItemKey = (item: ConversationItem): string => {
  switch (item.type) {
    case "user": {
      return `user:${item.eventId ?? item.cursor}`;
    }
    case "output": {
      return `output:${item.runId}`;
    }
    case "run": {
      return `run:${item.run.runId}`;
    }
    case "tool": {
      return `tool:${item.runId}:${item.toolId}`;
    }
    case "approval": {
      return `approval:${item.approvalId}`;
    }
    case "citation": {
      return `citation:${item.runId}:${item.sourceId}:${item.sourceVersion}`;
    }
    default: {
      return item satisfies never;
    }
  }
};

export const conversationItems = (
  messages: ConversationMessage[],
  initial: ConversationItem[]
): ConversationItem[] => {
  const items = new Map<string, ConversationItem>();
  const add = (item: ConversationItem) => {
    const key = conversationItemKey(item);
    const prior = items.get(key);
    if (
      item.type === "run" &&
      prior?.type === "run" &&
      terminalRunStates.has(prior.run.state) &&
      !terminalRunStates.has(item.run.state)
    ) {
      return;
    }
    items.set(key, item);
  };
  for (const item of initial) {
    add(item);
  }
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "data-conversation-item") {
        add(part.data);
      }
    }
  }
  return [...items.values()];
};

export const messageText = (message: ConversationMessage): string => {
  let text = "";
  let output: string | undefined;
  for (const part of message.parts) {
    if (part.type === "text") {
      text += part.text;
    } else if (
      part.type === "data-conversation-item" &&
      part.data.type === "output"
    ) {
      output = part.data.text;
    }
  }
  return output ?? text;
};
