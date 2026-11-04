import {
  AssistantEntry,
  ResetEntry,
  UserEntry,
} from "@earendil-works/pi-durable";
import type { EntryRecord } from "@earendil-works/pi-durable";

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
