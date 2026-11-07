import type {
  InspectionMessage,
  InspectionTask,
  InspectionTokens,
  InspectionTool,
} from "@cerebro/contracts/inspection";
import type { Message, Usage, ToolCall } from "@earendil-works/pi-ai";
import type {
  ConversationId,
  EntryId,
  EntryRecord,
  Harness,
  LiveState,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

import { inspectionText } from "./inspection-page.ts";

const checkpoint = Schema.Struct({
  phase: Schema.String,
  attempt: Schema.optional(Schema.Number),
  until: Schema.optional(Schema.Number),
  pollAt: Schema.optional(Schema.Number),
});
const finite = (value: number | undefined): number | null =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
type NativeTask = NonNullable<Awaited<ReturnType<Harness["getTask"]>>>;
export const inspectTask = (task: NativeTask): InspectionTask => {
  const known =
    task.kind === "pi.generation" ||
    task.kind === "pi.compaction" ||
    task.kind === "cerebro.team-admission";
  const state =
    known &&
    task.state.status !== "terminal" &&
    task.state.status !== "completing"
      ? Schema.decodeUnknownOption(checkpoint)(task.state.checkpoint)
      : undefined;
  const projected = state?._tag === "Some" ? state.value : undefined;
  return {
    id: String(task.id),
    kind: task.kind.slice(0, 2048),
    version: task.version,
    ownerTaskId: task.owner === undefined ? null : String(task.owner),
    background: task.background,
    abortRequested: task.abortRequested,
    status: task.state.status,
    outcome:
      task.state.status === "terminal" || task.state.status === "completing"
        ? task.state.outcome.status
        : null,
    phase: projected?.phase.slice(0, 2048) ?? null,
    attempt: finite(projected?.attempt),
    retryAt: finite(projected?.until ?? projected?.pollAt),
    startedAt: task.startedAt ?? null,
    endedAt: task.endedAt ?? null,
  };
};
export const emptyTokens = (): InspectionTokens => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
});
export const inspectUsage = (
  buckets: Readonly<Record<string, Usage>> | undefined
): InspectionTokens => {
  const total = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };
  for (const usage of Object.values(buckets ?? {})) {
    total.input += finite(usage.input) ?? 0;
    total.output += finite(usage.output) ?? 0;
    total.cacheRead += finite(usage.cacheRead) ?? 0;
    total.cacheWrite += finite(usage.cacheWrite) ?? 0;
    total.totalTokens += finite(usage.totalTokens) ?? 0;
  }
  return total;
};
const textInput = Schema.Struct({ text: Schema.String });
const workInput = Schema.Struct({ workId: Schema.String });
const safeToolInput = (
  name: string,
  args: unknown
): InspectionTool["input"] => {
  let text: string | undefined;
  if (name === "delegate_worker") {
    const parsed = Schema.decodeUnknownOption(textInput)(args);
    if (parsed._tag === "Some") {
      ({ text } = parsed.value);
    }
  } else if (name === "get_work" || name === "recall_work") {
    const parsed = Schema.decodeUnknownOption(workInput)(args);
    if (parsed._tag === "Some") {
      text = parsed.value.workId;
    }
  }
  return text === undefined
    ? { kind: "unavailable" }
    : {
        kind: "text",
        label: name === "delegate_worker" ? "Delegation" : "Query",
        content: inspectionText(text),
      };
};
const messageText = (message: Message): string => {
  if (message.role === "system") {
    return "";
  }
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
};
const inspectMessage = (
  message: Message,
  entryId: string,
  index: number
): InspectionMessage | null => {
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }
  return {
    id: `${entryId}:${index}`,
    entryId,
    role: message.role,
    content: inspectionText(
      message.role === "assistant" && message.stopReason === "error"
        ? "Generation failed."
        : messageText(message)
    ),
    modelId: message.role === "assistant" ? message.model.slice(0, 2048) : null,
    timestamp: message.timestamp,
    state:
      message.role === "assistant" && message.stopReason === "aborted"
        ? "interrupted"
        : "complete",
  };
};
interface ProjectedTool {
  readonly value: InspectionTool;
  readonly callId: string;
  readonly assistantEntryId: EntryId | null;
}
const inspectToolCall = (
  call: ToolCall,
  entry: EntryRecord,
  messageIndex: number,
  blockIndex: number
): ProjectedTool => ({
  value: {
    id: `call:${entry.id}:${messageIndex}:${blockIndex}`,
    callId: call.id.slice(0, 2048),
    name: call.name.slice(0, 2048),
    status: "unknown",
    input: safeToolInput(call.name, call.arguments),
    output: null,
    resultEntryId: null,
  },
  callId: call.id,
  assistantEntryId: entry.kind === "pi.assistant" ? entry.id : null,
});
const applyToolResult = (
  tools: ProjectedTool[],
  unmatched: Map<string, number>,
  message: Extract<Message, { role: "toolResult" }>,
  entryId: string,
  messageIndex: number
): void => {
  const index = unmatched.get(message.toolCallId);
  unmatched.delete(message.toolCallId);
  const previous = index === undefined ? undefined : tools[index];
  const result: InspectionTool = {
    id: previous?.value.id ?? `result:${entryId}:${messageIndex}`,
    callId: message.toolCallId.slice(0, 2048),
    name: message.toolName.slice(0, 2048),
    status: message.isError ? "failed" : "succeeded",
    input: previous?.value.input ?? { kind: "unavailable" },
    output: message.isError ? null : inspectionText(messageText(message)),
    resultEntryId: entryId,
  };
  if (previous && index !== undefined) {
    tools[index] = { ...previous, value: result };
  } else if (tools.length < 24) {
    tools.push({
      value: result,
      callId: message.toolCallId,
      assistantEntryId: null,
    });
  }
};
export const inspectEntries = (entries: readonly EntryRecord[]) => {
  const messages: InspectionMessage[] = [];
  const tools: ProjectedTool[] = [];
  const unmatched = new Map<string, number>();
  for (const entry of entries) {
    if (
      entry.kind !== "pi.user" &&
      entry.kind !== "pi.assistant" &&
      entry.kind !== "pi.tool-result"
    ) {
      continue;
    }
    for (const [index, message] of (entry.model ?? []).entries()) {
      const projected = inspectMessage(message, String(entry.id), index);
      if (projected && messages.length < 24) {
        messages.push(projected);
      }
      if (message.role === "assistant") {
        for (const [blockIndex, block] of message.content.entries()) {
          if (block.type !== "toolCall") {
            continue;
          }
          if (tools.length < 24) {
            unmatched.set(block.id, tools.length);
            tools.push(inspectToolCall(block, entry, index, blockIndex));
          } else {
            unmatched.delete(block.id);
          }
        }
      } else if (message.role === "toolResult") {
        applyToolResult(tools, unmatched, message, String(entry.id), index);
      }
    }
  }
  return { messages, tools };
};
const toolRound = Schema.Struct({
  phase: Schema.Literal("tools"),
  assistant: Schema.Number,
});
interface CurrentRound {
  readonly task: NativeTask | undefined;
  readonly conversationId: ConversationId;
}
const currentAssistant = (
  live: LiveState | undefined,
  round: CurrentRound | undefined
): number | undefined => {
  const task = round?.task;
  if (
    !task ||
    task.id !== live?.run?.taskId ||
    task.conversationId !== round?.conversationId ||
    task.kind !== "pi.generation" ||
    task.state.status === "terminal" ||
    task.state.status === "completing"
  ) {
    return;
  }
  const decoded = Schema.decodeUnknownOption(toolRound)(task.state.checkpoint);
  return decoded._tag === "Some" ? decoded.value.assistant : undefined;
};
export const inspectLive = (
  projected: ReturnType<typeof inspectEntries>,
  live?: LiveState,
  round?: CurrentRound
) => {
  const partial = live?.generation?.message;
  let { messages } = projected;
  if (partial && live?.run) {
    messages = [
      ...messages.slice(-23),
      {
        id: `partial:${live.run.taskId}`,
        entryId: String(live.run.taskId),
        role: "assistant" as const,
        content: inspectionText(messageText(partial)),
        modelId: partial.model.slice(0, 2048),
        timestamp: partial.timestamp,
        state: "streaming" as const,
      },
    ];
  }
  const assistant = currentAssistant(live, round);
  const tools = projected.tools.map(({ value, callId, assistantEntryId }) => {
    const saved =
      assistantEntryId !== null &&
      assistantEntryId === assistant &&
      value.resultEntryId === null
        ? live?.tools?.find((slot) => slot.callId === callId)
        : undefined;
    return saved && saved.status !== "done"
      ? { ...value, status: saved.status }
      : value;
  });
  return { messages, tools };
};
