/* oxlint-disable no-await-in-loop, promise/avoid-new, require-yield -- Serial observation polls and manual stream barriers never submit work; connect fails immediately. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { ChatClient, stream } from "@tanstack/ai-client";

const waitFor = async (condition) => {
  for (let i = 0; i < 100; i += 1) {
    if (condition()) {
      return;
    }
    await delay(10);
  }
  assert.fail("observation did not arrive");
};

test("public hydrate, attach, detach and reattach observe an existing run without connect", async () => {
  const calls = { hydrate: 0, join: 0, observers: 0, submit: 0 };
  let release;
  let approved = false;
  const connection = stream(
    async function* connection() {
      calls.submit += 1;
      assert.fail("observation must never submit");
    },
    {
      hydrate: () => {
        calls.hydrate += 1;
        return Promise.resolve({
          activeRun: { runId: "run-A" },
          interrupts: null,
          messages: [
            {
              id: "user",
              parts: [{ content: "existing question", type: "text" }],
              role: "user",
            },
          ],
        });
      },
      async *joinRun(runId, signal) {
        assert.equal(runId, "run-A");
        calls.join += 1;
        calls.observers += 1;
        try {
          yield { runId, threadId: "conversation", type: "RUN_STARTED" };
          yield {
            messageId: "answer",
            role: "assistant",
            type: "TEXT_MESSAGE_START",
          };
          yield {
            delta: "early",
            messageId: "answer",
            type: "TEXT_MESSAGE_CONTENT",
          };
          await new Promise((resolve) => {
            release = resolve;
            signal.addEventListener("abort", resolve, { once: true });
          });
          if (signal.aborted) {
            return;
          }
          assert.equal(approved, true);
          yield {
            name: "cerebro.approval",
            type: "CUSTOM",
            value: { decision: "allow", runId },
          };
          yield {
            delta: " final",
            messageId: "answer",
            type: "TEXT_MESSAGE_CONTENT",
          };
          yield { messageId: "answer", type: "TEXT_MESSAGE_END" };
          yield { runId, threadId: "conversation", type: "RUN_FINISHED" };
        } finally {
          calls.observers -= 1;
        }
      },
    }
  );
  const client = new ChatClient({
    connection,
    id: "conversation",
    persistence: true,
    threadId: "conversation",
  });
  try {
    assert.equal(calls.join, 0);
    client.attach();
    await waitFor(() => calls.join === 1 && release);
    client.detach();
    await waitFor(() => calls.observers === 0);
    client.attach();
    await waitFor(() => calls.join === 2 && calls.observers === 1);
    approved = true;
    release();
    await waitFor(() => calls.observers === 0);
    await waitFor(() =>
      JSON.stringify(client.getMessages()).includes("early final")
    );
    assert.equal(calls.submit, 0);
    assert.equal(calls.hydrate, 2);
  } finally {
    client.detach();
    client.dispose();
  }
});
