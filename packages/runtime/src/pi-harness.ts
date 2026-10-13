import type { EventAddress } from "@cerebro/contracts/events";
import type {
  ChatMessage,
  ChatSnapshot,
} from "@cerebro/contracts/session-service";
import { isInternalToolName } from "@cerebro/tools/tool-names";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationView, Harness } from "@earendil-works/pi-durable";
import { Schema } from "effect";

export const snapshotToolIds = (snapshot: ChatSnapshot): readonly string[] => [
  ...new Set([
    ...snapshot.messages.flatMap((message) =>
      message.toolName && !isInternalToolName(message.toolName)
        ? [message.toolName]
        : []
    ),
    ...snapshot.approvals.map((approval) => approval.toolId),
  ]),
];

export type PiContext = Parameters<Harness["root"]>[0];
export const piContext = (signal?: AbortSignal): PiContext =>
  Object.freeze({
    abortSignal: signal,
    toString: () => "[Context Cerebro Pi]",
    // oxlint-disable-next-line no-useless-undefined -- A missing Chord context key has an undefined value.
    value: () => undefined,
  });

const partialBlock = Schema.Union([
  Schema.Struct({ text: Schema.String, type: Schema.Literal("text") }),
  Schema.Struct({
    redacted: Schema.optional(Schema.Boolean),
    thinking: Schema.String,
    type: Schema.Literal("thinking"),
  }),
  Schema.Struct({ type: Schema.Literal("toolCall") }),
]);
const liveSchema = Schema.Struct({
  generation: Schema.optional(
    Schema.Struct({
      message: Schema.optional(
        Schema.Struct({ content: Schema.Array(partialBlock) })
      ),
    })
  ),
  run: Schema.optional(Schema.Struct({ taskId: Schema.Number })),
});
const inboxSchema = Schema.Struct({ items: Schema.Array(Schema.Unknown) });

const presentedMessage = (
  message: Message,
  id: string
): ChatMessage | undefined => {
  if (message.role === "system") {
    return undefined;
  }
  if (message.role === "user") {
    return {
      id,
      role: "user",
      state: "complete",
      text:
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join(""),
    };
  }
  if (message.role === "toolResult") {
    return {
      id,
      role: "tool",
      state: "complete",
      text: message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
      toolName: message.toolName,
    };
  }
  const thinking = message.content
    .filter((block) => block.type === "thinking")
    .filter((block) => !block.redacted)
    .map((block) => block.thinking)
    .join("");
  return {
    id,
    role: "assistant",
    state: "complete",
    text: message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""),
    ...(thinking ? { thinking } : {}),
  };
};

export const chatSnapshot = (input: {
  readonly address: EventAddress;
  readonly agentVersion: number;
  readonly approvals: ChatSnapshot["approvals"];
  readonly view: ConversationView;
}): ChatSnapshot => {
  const { view } = input;
  const messages: ChatMessage[] = [];
  for (const entry of view.entries) {
    for (const [index, message] of (entry.model ?? []).entries()) {
      const presented = presentedMessage(
        message,
        entry.model?.length === 1 ? String(entry.id) : `${entry.id}:${index}`
      );
      if (presented) {
        messages.push(presented);
      }
    }
  }
  const live = Schema.decodeUnknownSync(liveSchema)(view.docs["pi.live"] ?? {});
  const inbox = Schema.decodeUnknownSync(inboxSchema)(
    view.docs["pi.inbox"] ?? { items: [] }
  );
  const partial = live.generation?.message;
  if (partial && live.run) {
    const text = partial.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const thinking = partial.content
      .filter((block) => block.type === "thinking")
      .filter((block) => !block.redacted)
      .map((block) => block.thinking)
      .join("");
    messages.push({
      id: `partial:${live.run.taskId}`,
      role: "assistant",
      state: "streaming",
      text,
      ...(thinking ? { thinking } : {}),
    });
  }
  return {
    address: input.address,
    agentVersion: input.agentVersion,
    approvals: input.approvals,
    busy: live.run !== undefined || inbox.items.length > 0,
    messages,
  };
};
