import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantEntry, UserEntry } from "@earendil-works/pi-durable";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";

export const appendPassiveUser = (
  tx: Tx,
  nativeId: ConversationId,
  text: string
) =>
  tx.appendEntry(UserEntry, nativeId, {
    model: [{ role: "user", content: text, timestamp: Date.now() }],
  });

export const appendPassiveAnswer = (
  tx: Tx,
  nativeId: ConversationId,
  text: string,
  model: Model<Api>
) => {
  const message: AssistantMessage = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  return tx.appendEntry(AssistantEntry, nativeId, { model: [message] });
};
