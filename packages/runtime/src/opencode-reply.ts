import type { OpenCodeWorkerd } from "@opencode-ai/sdk/workerd";

export type ModelReply =
  | { readonly kind: "completed"; readonly text: string }
  | { readonly kind: "pending" }
  | { readonly kind: "invalid"; readonly reason: string };

export const readFinalReply = async (
  client: OpenCodeWorkerd.Interface,
  sessionId: string
): Promise<ModelReply> => {
  const messages = await client.message.list({
    order: "asc",
    sessionID: sessionId,
  });
  const assistant = messages.data.findLast(
    (message) => message.type === "assistant"
  );
  if (!assistant || assistant.error) {
    return {
      kind: "invalid",
      reason: "The SDK completed without a valid final model response.",
    };
  }
  if (assistant.finish === undefined || assistant.finish === "tool-calls") {
    return { kind: "pending" };
  }
  const text = assistant.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  if (!text) {
    return {
      kind: "invalid",
      reason:
        assistant.finish === "length"
          ? "The model reached its output token limit before it produced an answer."
          : "The model completed without answer text.",
    };
  }
  return { kind: "completed", text };
};
