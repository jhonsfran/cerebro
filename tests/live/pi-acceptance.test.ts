import assert from "node:assert/strict";
import { test } from "node:test";

import { id } from "../../packages/contracts/src/identity.ts";
import type { ChatSnapshot } from "../../packages/contracts/src/session-service.ts";
import {
  decodeLiveReceipt,
  decodeLiveSnapshot,
  waitForLiveRead,
} from "./pi-acceptance.ts";

const prompt = "Read one permitted item.";
const snapshot = (): ChatSnapshot => ({
  address: {
    agentId: id.agent("live-agent"),
    conversationId: id.conversation("live-conversation"),
    organizationId: id.organization("live-organization"),
    sessionId: id.session("live-public-session"),
  },
  agentVersion: 1,
  approvals: [],
  busy: false,
  messages: [
    { id: "1", role: "user", state: "complete", text: prompt },
    { id: "2", role: "assistant", state: "complete", text: "" },
    {
      id: "3",
      role: "tool",
      state: "complete",
      text: "Private tool response",
      toolName: "remote_lookup",
    },
    { id: "4", role: "assistant", state: "complete", text: "Private answer" },
  ],
  queuedInputs: [],
  tools: [
    {
      arguments: { query: "Private tool argument" },
      callId: "call-1",
      id: "2:0:0",
      messageId: "2",
      output: "Private tool response",
      resultMessageId: "3",
      state: "succeeded",
      toolName: "remote_lookup",
    },
  ],
});
const options = {
  agentId: "live-agent",
  conversationId: "live-conversation",
  pollMs: 0,
  prompt,
  toolId: "remote_lookup",
};

test("live acceptance decodes native receipts and rejects legacy or malformed responses without input text", () => {
  assert.deepEqual(
    decodeLiveReceipt({
      receipt: { accepted: true, operationId: "live-operation", session: "8" },
    }),
    {
      accepted: true,
      operationId: "live-operation",
      session: "8",
    }
  );
  assert.throws(
    () => decodeLiveReceipt({ receipt: { runId: "Private legacy ID" } }),
    {
      message: "The live receipt does not match the native chat contract.",
    }
  );
  assert.throws(
    () =>
      decodeLiveSnapshot({ snapshot: { outputs: ["Private legacy output"] } }),
    {
      message: "The live snapshot does not match the native chat contract.",
    }
  );
});

test("live polling waits for queued input, the running read and a final answer after the result", async () => {
  const complete = snapshot();
  const queued: ChatSnapshot = {
    ...complete,
    busy: true,
    messages: [],
    queuedInputs: [
      { mode: "followUp", submissionId: "operation", text: prompt },
    ],
    tools: [],
  };
  const running: ChatSnapshot = {
    ...complete,
    busy: true,
    messages: complete.messages.slice(0, 2),
    tools: complete.tools.map((tool) => ({
      ...tool,
      resultMessageId: undefined,
      state: "running",
    })),
  };
  const states = [queued, running, complete];
  let reads = 0;
  const result = await waitForLiveRead({
    ...options,
    read: () => {
      const state = states[reads];
      assert.ok(state);
      reads += 1;
      return Promise.resolve({ snapshot: state });
    },
  });
  assert.equal(reads, 3);
  assert.equal(result.execution.id, "2:0:0");
  assert.equal(result.answer.id, "4");
});

test("an assistant message before a completed tool result is not accepted as the final answer", async () => {
  const complete = snapshot();
  const early = {
    ...complete,
    messages: complete.messages
      .slice(0, 3)
      .map((message) =>
        message.id === "2"
          ? { ...message, text: "I will read the item." }
          : message
      ),
  };
  let reads = 0;
  const result = await waitForLiveRead({
    ...options,
    read: () => {
      const current = reads === 0 ? early : complete;
      reads += 1;
      return Promise.resolve({ snapshot: current });
    },
  });
  assert.equal(reads, 2);
  assert.equal(result.answer.id, "4");
});

test("failed reads and extra executions fail with sanitized diagnostics", async () => {
  const complete = snapshot();
  await assert.rejects(
    waitForLiveRead({
      ...options,
      read: () =>
        Promise.resolve({
          snapshot: {
            ...complete,
            tools: complete.tools.map((tool) => ({ ...tool, state: "failed" })),
          },
        }),
    }),
    {
      message: "The live MCP read did not succeed.",
    }
  );
  await assert.rejects(
    waitForLiveRead({
      ...options,
      read: () =>
        Promise.resolve({
          snapshot: {
            ...complete,
            tools: [...complete.tools, { ...complete.tools[0], id: "extra" }],
          },
        }),
    }),
    {
      message: "The live input requested work beyond its single MCP read.",
    }
  );
});

test("a skipped MCP read, duplicated input or foreign conversation cannot satisfy live acceptance", async () => {
  const complete = snapshot();
  await assert.rejects(
    waitForLiveRead({
      ...options,
      read: () => Promise.resolve({ snapshot: { ...complete, tools: [] } }),
    }),
    {
      message: "The live model answered without the required MCP read.",
    }
  );
  await assert.rejects(
    waitForLiveRead({
      ...options,
      read: () =>
        Promise.resolve({
          snapshot: {
            ...complete,
            messages: [
              ...complete.messages,
              { id: "5", role: "user", state: "complete", text: prompt },
            ],
          },
        }),
    }),
    {
      message: "The live input was not represented exactly once.",
    }
  );
  await assert.rejects(
    waitForLiveRead({
      ...options,
      conversationId: "foreign",
      read: () => Promise.resolve({ snapshot: complete }),
    }),
    {
      message: "The live snapshot belongs to another conversation.",
    }
  );
});
