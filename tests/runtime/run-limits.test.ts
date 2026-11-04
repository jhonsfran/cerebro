import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import type { TranscriptContext } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  AssistantEntry,
  CompactionEntry,
  Harness,
  MemoryStorage,
  ResetEntry,
  ToolResultEntry,
  UserEntry,
  createRegistry,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import type {
  EntryRecord,
  ToolRegistration,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import {
  createRunLimits,
  runToolCallIds,
} from "../../packages/runtime/src/run-limits.ts";

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

const context = piContext();
const lastInput = (transcript: TranscriptContext): string => {
  const input = transcript.messages.findLast(
    (message) => message.role === "user"
  );
  return typeof input?.content === "string" ? input.content : "";
};

test("a run that keeps calling tools is blocked after 50 calls and ended after 10 more", async () => {
  const models = createModels();
  const registry = createRegistry();
  const pi = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      settings: {
        compaction: { enabled: false },
        extensions: [],
        progress: { outputIntervalMs: 0, partialIntervalMs: 0 },
        retry: { enabled: false },
      },
    },
    context
  );
  try {
    let lookups = 0;
    const lookup: ToolRegistration = {
      description: "Read one page of company rows.",
      execute: () => {
        lookups += 1;
        return Promise.resolve({ output: [{ text: "Rows", type: "text" }] });
      },
      name: "company_lookup",
      parameters: Type.Object({}),
      replay: "safe",
    };
    const faux = fauxProvider({ provider: "run-limits" });
    faux.setResponses(
      Array.from({ length: 40 }, () => (transcript: TranscriptContext) => {
        if (lastInput(transcript) === "Read every row") {
          return fauxAssistantMessage(
            Array.from({ length: 4 }, () => fauxToolCall("company_lookup", {})),
            { stopReason: "toolUse" }
          );
        }
        return transcript.messages.at(-1)?.role === "toolResult"
          ? fauxAssistantMessage("One more row read")
          : fauxAssistantMessage(fauxToolCall("company_lookup", {}), {
              stopReason: "toolUse",
            });
      })
    );
    models.setProvider(faux.provider);
    const extension = {
      hooks: createRunLimits({ pi }),
      name: "run-limits",
      tools: [lookup],
    };
    registry.install(extension);
    const conversation = await pi.createConversation(
      { ownership: { kind: "ownerless" } },
      context
    );
    const model = faux.getModel();
    await conversation.configure(
      {
        extensions: [extension],
        model: { modelId: model.id, provider: model.provider },
      },
      context
    );

    const looping = await conversation.submit(
      { content: "Read every row", type: "input" },
      context
    );
    const settled = await looping.wait(context);
    assert.equal(settled.status, "unanswered");
    assert.equal("reason" in settled ? settled.reason : undefined, "aborted");
    assert.equal(lookups, 50);
    assert.equal(faux.state.callCount, 16);
    const transcript = await conversation.context(context);
    const results = transcript.messages.flatMap((message) =>
      message.role === "toolResult"
        ? [
            message.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join(""),
          ]
        : []
    );
    const blocked =
      "<harness>\n[error] Tool call blocked: This run reached its limit of 50 tool calls. " +
      "Answer with what you have, or ask the person to continue in a new message.\n</harness>";
    assert.deepEqual(results.slice(48, 52), ["Rows", "Rows", blocked, blocked]);
    assert.equal(results.length, 64);
    assert.equal(results.filter((text) => text === blocked).length, 14);

    const next = await conversation.submit(
      { content: "Read one more row", type: "input" },
      context
    );
    const answered = await next.wait(context);
    assert.equal(answered.status, "done");
    assert.equal(lookups, 51);
  } finally {
    await pi.close(context);
  }
});
