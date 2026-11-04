import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  AssistantEntry,
  CompactionEntry,
  ResetEntry,
  ToolResultEntry,
  UserEntry,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import type { EntryRecord } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { runToolCallIds } from "../../packages/runtime/src/run-limits.ts";

const user = (text: string) => ({
  kind: UserEntry.kind,
  model: [{ content: text, role: "user" as const, timestamp: 0 }],
});
const calls = (...ids: string[]) => ({
  kind: AssistantEntry.kind,
  model: [
    fauxAssistantMessage(
      ids.map((id) => fauxToolCall("company_lookup", {}, { id })),
      { stopReason: "toolUse" }
    ),
  ],
});
const answer = (text: string) => ({
  kind: AssistantEntry.kind,
  model: [fauxAssistantMessage(text)],
});
const result = { kind: ToolResultEntry.kind };
const newestFirst = (
  ...transcript: Pick<EntryRecord, "kind" | "model">[]
): Pick<EntryRecord, "kind" | "model">[] => transcript.toReversed();

test("a run counts every call of its rounds in transcript order", () => {
  assert.deepEqual(
    runToolCallIds(
      newestFirst(
        user("Compare the accounts"),
        calls("a", "b", "c"),
        result,
        result,
        result,
        calls("d", "e"),
        result,
        result
      )
    ),
    ["a", "b", "c", "d", "e"]
  );
});

test("a new message starts a run that does not count earlier calls", () => {
  assert.deepEqual(
    runToolCallIds(
      newestFirst(
        user("First question"),
        calls("old-1", "old-2"),
        result,
        result,
        answer("First answer"),
        user("Second question"),
        calls("new-1")
      )
    ),
    ["new-1"]
  );
});

test("a context reset starts a new run", () => {
  assert.deepEqual(
    runToolCallIds(
      newestFirst(
        user("Question"),
        calls("before-1", "before-2"),
        result,
        result,
        { kind: ResetEntry.kind },
        calls("after-1")
      )
    ),
    ["after-1"]
  );
});

test("compaction keeps counting the same run", () => {
  assert.deepEqual(
    runToolCallIds(
      newestFirst(
        user("Question"),
        calls("before-1", "before-2"),
        result,
        result,
        {
          kind: CompactionEntry.kind,
          model: [{ content: "Summary", role: "user" as const, timestamp: 0 }],
        },
        calls("after-1")
      )
    ),
    ["before-1", "before-2", "after-1"]
  );
});
