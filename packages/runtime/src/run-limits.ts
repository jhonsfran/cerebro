import { NotFound } from "@cerebro/contracts/failures";
import {
  AssistantEntry,
  GenerationTask,
  ResetEntry,
  ToolTask,
  UserEntry,
  hook,
} from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Cursor,
  EntryRecord,
  Harness,
  HookRegistration,
} from "@earendil-works/pi-durable";

import { abortOwnTask } from "./pi-harness.ts";
import type { PiContext } from "./pi-harness.ts";

const MAX_TOOL_CALLS_PER_RUN = 50;
const BLOCKED_CALL_ALLOWANCE = 10;
const PAGE_SIZE = 64;

type RunEntry = Pick<EntryRecord, "kind" | "model">;

const startsRun = (entry: RunEntry): boolean =>
  entry.kind === UserEntry.kind || entry.kind === ResetEntry.kind;

/**
 * Tool call IDs of the current run in transcript order, from entries newest first. A person's or scheduled message,
 * or a context reset, starts a run; compaction does not, so a summarized run keeps its count.
 */
export const runToolCallIds = (newestFirst: readonly RunEntry[]): string[] => {
  const start = newestFirst.findIndex(startsRun);
  return newestFirst
    .slice(0, start === -1 ? newestFirst.length : start)
    .filter((entry) => entry.kind === AssistantEntry.kind)
    .toReversed()
    .flatMap((entry) => entry.model ?? [])
    .flatMap((message) => (message.role === "assistant" ? message.content : []))
    .flatMap((part) => (part.type === "toolCall" ? [part.id] : []));
};

export const createRunLimits = (options: {
  readonly pi: Harness;
}): HookRegistration[] => {
  // The hard stop below ends a run soon after the limit, so reading back to the run's start stays bounded.
  const currentRun = async (
    conversationId: ConversationId,
    context: PiContext
  ): Promise<string[]> => {
    const conversation = await options.pi.conversation(conversationId, context);
    if (!conversation) {
      throw new NotFound({ resource: "Conversation" });
    }
    const entries: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    let started = false;
    do {
      // oxlint-disable-next-line no-await-in-loop -- Read newest first, one bounded page at a time, until the run starts.
      const page = await conversation.entries({}, PAGE_SIZE, cursor, context);
      entries.push(...page.items);
      started = page.items.some(startsRun);
      cursor = page.next;
    } while (cursor && !started);
    return runToolCallIds(entries);
  };

  return [
    hook(ToolTask, {
      beforeTool: async (call, api, context) => {
        if (call.parent) {
          return;
        }
        const calls = await currentRun(api.conversationId, context);
        if (calls.indexOf(call.id) + 1 > MAX_TOOL_CALLS_PER_RUN) {
          return {
            block:
              `This run reached its limit of ${MAX_TOOL_CALLS_PER_RUN} tool calls. ` +
              "Answer with what you have, or ask the person to continue in a new message.",
          };
        }
      },
    }),
    // A model that keeps calling tools after the block would loop on blocked calls, so end the run.
    hook(GenerationTask, {
      beforeRequest: async (_request, api, context) => {
        const calls = await currentRun(api.conversationId, context);
        if (calls.length > MAX_TOOL_CALLS_PER_RUN + BLOCKED_CALL_ALLOWANCE) {
          await abortOwnTask(options.pi, api.taskId, context);
          throw new Error("The run reached its tool call limit.");
        }
      },
    }),
  ];
};
