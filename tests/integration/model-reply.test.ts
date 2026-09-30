import assert from "node:assert/strict";
import { test } from "node:test";

import type { OpenCodeWorkerd } from "@opencode-ai/sdk/workerd";

import { readFinalReply } from "../../packages/runtime/src/opencode-reply.ts";

const reply = async (messages: readonly unknown[]) => {
  const client = {
    message: { list: () => Promise.resolve({ data: messages }) },
  } as unknown as OpenCodeWorkerd.Interface;
  return await readFinalReply(client, "session-test");
};

test("a recovered running tool assistant remains pending until its continuation finishes", async () => {
  const result = await reply([
    {
      content: [{ text: "Earlier answer", type: "text" }],
      finish: "stop",
      type: "assistant",
    },
    {
      content: [{ state: { status: "running" }, type: "tool" }],
      type: "assistant",
    },
  ]);
  assert.deepEqual(result, { kind: "pending" });
});

test("a completed tool-call step is pending rather than a final answer", async () => {
  assert.deepEqual(
    await reply([{ content: [], finish: "tool-calls", type: "assistant" }]),
    { kind: "pending" }
  );
});

test("reasoning that exhausts the token cap without text cannot become a completed answer", async () => {
  assert.deepEqual(
    await reply([
      {
        content: [{ text: "Private reasoning", type: "reasoning" }],
        finish: "length",
        type: "assistant",
      },
    ]),
    {
      kind: "invalid",
      reason:
        "The model reached its output token limit before it produced an answer.",
    }
  );
});

test("a final response exposes only its visible answer text", async () => {
  assert.deepEqual(
    await reply([
      {
        content: [
          { text: "Private reasoning", type: "reasoning" },
          { text: "  Final answer  ", type: "text" },
        ],
        finish: "stop",
        type: "assistant",
      },
    ]),
    { kind: "completed", text: "Final answer" }
  );
});

test("an errored or empty final assistant cannot complete the run", async () => {
  const empty = await reply([
    { content: [], finish: "stop", type: "assistant" },
  ]);
  assert.equal(empty.kind, "invalid");
  const failed = await reply([
    {
      content: [{ text: "Partial", type: "text" }],
      error: { message: "Provider failed" },
      finish: "stop",
      type: "assistant",
    },
  ]);
  assert.equal(failed.kind, "invalid");
});
