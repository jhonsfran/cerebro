import type { EventAddress } from "@cerebro/contracts/events";
import { ChatToolExecution } from "@cerebro/contracts/session-service";
import type {
  ChatMessage,
  ChatQueuedInput,
  ChatSnapshot,
} from "@cerebro/contracts/session-service";
import { isInternalToolName } from "@cerebro/tools/tool-names";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationView, Harness } from "@earendil-works/pi-durable";
import { Schema } from "effect";

export const snapshotToolIds = (snapshot: ChatSnapshot): readonly string[] => [
  ...new Set(
    [
      ...snapshot.messages.flatMap((message) =>
        message.toolName ? [message.toolName] : []
      ),
      ...snapshot.approvals.map((approval) => approval.toolId),
      ...snapshot.tools.map((tool) => tool.toolName),
      ...(snapshot.activity?.children ?? []).flatMap((child) =>
        child.tools.map((tool) => tool.toolName)
      ),
    ].filter((toolName) => !isInternalToolName(toolName))
  ),
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
  tools: Schema.optional(
    Schema.Array(
      Schema.Struct({
        callId: Schema.String,
        entry: Schema.optional(Schema.Number),
        name: Schema.String,
        output: Schema.optional(Schema.String),
        status: Schema.Literals(["pending", "running", "done"]),
      })
    )
  ),
});
const inputContent = Schema.Union([
  Schema.String,
  Schema.Array(
    Schema.Union([
      Schema.Struct({ text: Schema.String, type: Schema.Literal("text") }),
      Schema.Struct({ type: Schema.Literal("image") }),
    ])
  ),
]);
const inboxSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Union([
      Schema.Struct({
        content: inputContent,
        id: Schema.Number,
        mode: Schema.Literals(["steer", "followUp"]),
      }),
      Schema.Struct({ id: Schema.Number, mode: Schema.Literal("write") }),
    ])
  ),
});

const queuedInputs = (inbox: typeof inboxSchema.Type): ChatQueuedInput[] =>
  inbox.items.flatMap((item) =>
    item.mode === "write"
      ? []
      : [
          {
            mode: item.mode,
            submissionId: String(item.id),
            text:
              typeof item.content === "string"
                ? item.content
                : item.content
                    .map((part) =>
                      part.type === "text" ? part.text : "[Image]"
                    )
                    .join("\n"),
          },
        ]
  );

const applyLiveToolSlots = (
  tools: ChatToolExecution[],
  slots: NonNullable<typeof liveSchema.Type.tools>
): ChatToolExecution[] => {
  for (const slot of slots) {
    if (slot.entry !== undefined) {
      continue;
    }
    const index = tools.findLastIndex(
      (tool) =>
        tool.callId === slot.callId && tool.resultMessageId === undefined
    );
    const tool = tools[index];
    if (!tool) {
      continue;
    }
    tools[index] = {
      ...tool,
      output: slot.output ?? "",
      state: slot.status === "done" ? "interrupted" : slot.status,
    };
  }
  return tools;
};

const toolExecutions = (
  view: ConversationView,
  live: typeof liveSchema.Type
): ChatToolExecution[] => {
  const tools: ChatToolExecution[] = [];
  const unmatched = new Map<string, number[]>();
  for (const entry of view.entries) {
    for (const [modelIndex, message] of (entry.model ?? []).entries()) {
      const messageId =
        entry.model?.length === 1
          ? String(entry.id)
          : `${entry.id}:${modelIndex}`;
      if (message.role === "assistant") {
        unmatched.clear();
        for (const [blockIndex, block] of message.content.entries()) {
          if (block.type !== "toolCall") {
            continue;
          }
          const index = tools.length;
          tools.push({
            arguments: Schema.decodeUnknownSync(
              ChatToolExecution.fields.arguments
            )(block.arguments),
            callId: block.id,
            id: `${entry.id}:${modelIndex}:${blockIndex}`,
            messageId,
            output: "",
            state: "interrupted",
            toolName: block.name,
          });
          const indices = unmatched.get(block.id) ?? [];
          indices.push(index);
          unmatched.set(block.id, indices);
        }
      } else if (message.role === "toolResult") {
        const index = unmatched.get(message.toolCallId)?.shift();
        const tool = index === undefined ? undefined : tools[index];
        if (index === undefined || !tool) {
          continue;
        }
        tools[index] = {
          ...tool,
          output: message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(""),
          resultMessageId: messageId,
          state: message.isError ? "failed" : "succeeded",
        };
      }
    }
  }
  return applyLiveToolSlots(tools, live.tools ?? []);
};

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

export const chatPresentation = (
  view: ConversationView
): Pick<ChatSnapshot, "busy" | "messages" | "queuedInputs" | "tools"> => {
  const messages: ChatMessage[] = [];
  for (const entry of view.entries) {
    for (const [index, message] of (entry.model ?? []).entries()) {
      const presented = presentedMessage(
        message,
        entry.model?.length === 1 ? String(entry.id) : `${entry.id}:${index}`
      );
      if (presented) {
        messages.push({
          ...presented,
          ...(entry.kind === "pi.compaction"
            ? { kind: "summary" as const, role: "assistant" as const }
            : {}),
          ...(presented.role !== "tool" &&
          entry.kind !== "pi.compaction" &&
          entry.kind !== "pi.reset"
            ? { entryId: String(entry.id) }
            : {}),
        });
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
    busy: live.run !== undefined || inbox.items.length > 0,
    messages,
    queuedInputs: queuedInputs(inbox),
    tools: toolExecutions(view, live),
  };
};

export const chatSnapshot = (input: {
  readonly address: EventAddress;
  readonly agentVersion: number;
  readonly approvals: ChatSnapshot["approvals"];
  readonly view: ConversationView;
}): ChatSnapshot => ({
  address: input.address,
  agentVersion: input.agentVersion,
  approvals: input.approvals,
  ...chatPresentation(input.view),
});
