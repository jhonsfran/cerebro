import type {
  InspectionMessage,
  InspectionTask,
  InspectionTokens,
  InspectionTool,
} from "@cerebro/contracts/inspection";
import type { Message, Usage, ToolCall } from "@earendil-works/pi-ai";
import type {
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
const termInput = Schema.Struct({ term: Schema.String });
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
  } else if (name === "search_conversations") {
    const parsed = Schema.decodeUnknownOption(termInput)(args);
    if (parsed._tag === "Some") {
      text = parsed.value.term;
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
const inspectToolCall = (call: ToolCall): InspectionTool => ({
  id: call.id.slice(0, 2048),
  name: call.name.slice(0, 2048),
  status: "unknown",
  input: safeToolInput(call.name, call.arguments),
  output: null,
  resultEntryId: null,
});
const applyToolResult = (
  tools: InspectionTool[],
  message: Extract<Message, { role: "toolResult" }>,
  entryId: string
): void => {
  const index = tools.findLastIndex(
    (candidate) => candidate.id === message.toolCallId
  );
  const previous = tools[index];
  const result: InspectionTool = {
    id: message.toolCallId.slice(0, 2048),
    name: message.toolName.slice(0, 2048),
    status: message.isError ? "failed" : "succeeded",
    input: previous?.input ?? { kind: "unavailable" },
    output: message.isError ? null : inspectionText(messageText(message)),
    resultEntryId: entryId,
  };
  if (previous) {
    tools[index] = result;
  } else if (tools.length < 24) {
    tools.push(result);
  }
};
export const inspectEntries = (entries: readonly EntryRecord[]) => {
  const messages: InspectionMessage[] = [];
  const tools: InspectionTool[] = [];
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
        tools.push(
          ...message.content
            .filter((block) => block.type === "toolCall")
            .slice(0, 24 - tools.length)
            .map(inspectToolCall)
        );
      } else if (message.role === "toolResult") {
        applyToolResult(tools, message, String(entry.id));
      }
    }
  }
  return { messages, tools };
};
export const inspectLive = (
  projected: ReturnType<typeof inspectEntries>,
  live: LiveState | undefined
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
  const tools = projected.tools.map((tool) => {
    const saved = live?.tools?.find((slot) => slot.callId === tool.id);
    return saved && saved.status !== "done"
      ? { ...tool, status: saved.status }
      : tool;
  });
  return { messages, tools };
};
