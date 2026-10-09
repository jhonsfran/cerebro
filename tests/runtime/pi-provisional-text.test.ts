import assert from "node:assert/strict";
import { test } from "node:test";

import { fauxAssistantMessage } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { idFromNumber } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/ids.js";
import type {
  AgentEvent,
  SubmissionId,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { createProvisionalTextProjection } from "../../packages/runtime/src/pi-provisional-text.ts";

const snapshot = (
  text: string,
  timestamp = 1000,
  attempt = 1
): Extract<AgentEvent, { type: "snapshot" }> => ({
  agent: {},
  compactions: [],
  entries: [],
  generation: {
    attempt,
    message: { ...fauxAssistantMessage(text), timestamp },
  },
  inbox: [],
  run: { inputs: [] },
  tools: [],
  type: "snapshot",
  usage: { models: {}, tools: {} },
});

test("the first partial message and later deltas deliver each word once", () => {
  const project = createProvisionalTextProjection();
  assert.equal(
    project({
      message: fauxAssistantMessage("Cerebro"),
      type: "message_start",
    }),
    "Cerebro"
  );
  assert.equal(
    project({
      changes: [{ contentIndex: 0, delta: " slice", type: "text_delta" }],
      type: "message_update",
      usage: fauxAssistantMessage("").usage,
    }),
    " slice"
  );
  assert.equal(
    project({
      changes: [
        {
          block: { text: "Cerebro slice", type: "text" },
          contentIndex: 0,
          type: "block",
        },
        {
          block: { text: " 1", type: "text" },
          contentIndex: 1,
          type: "text_start",
        },
      ],
      type: "message_update",
      usage: fauxAssistantMessage("").usage,
    }),
    " 1"
  );
});

test("whole message replacements emit only new text and ignore non-prefix rewrites", () => {
  const project = createProvisionalTextProjection();
  const replace = (text: string) =>
    project({
      changes: [{ message: fauxAssistantMessage(text), type: "message" }],
      type: "message_update",
      usage: fauxAssistantMessage("").usage,
    });
  assert.equal(replace("A"), "A");
  assert.equal(replace("A"), "");
  assert.equal(replace("AB"), "B");
  assert.equal(replace("Rewrite"), "");
  assert.equal(replace("ABC"), "C");
});

test("a new assistant message resets the prior generation", () => {
  const project = createProvisionalTextProjection();
  assert.equal(
    project({ message: fauxAssistantMessage("First"), type: "message_start" }),
    "First"
  );
  assert.equal(project({ inputs: [], type: "run_end" }), "");
  assert.equal(
    project({ message: fauxAssistantMessage("Second"), type: "message_start" }),
    "Second"
  );
});

test("attachment and overflow snapshots retain partial text without duplicate prefixes", () => {
  const project = createProvisionalTextProjection();
  assert.equal(project(snapshot("First")), "First");
  assert.equal(project(snapshot("First")), "");
  assert.equal(project(snapshot("First partial")), " partial");
  assert.equal(project(snapshot("Second", 2000)), "Second");
  assert.equal(project(snapshot("Retry", 2000, 2)), "Retry");
});

test("replacing a text block with thinking cannot retain its old prefix", () => {
  const project = createProvisionalTextProjection();
  assert.equal(
    project({ message: fauxAssistantMessage("A"), type: "message_start" }),
    "A"
  );
  assert.equal(
    project({
      changes: [
        {
          block: { thinking: "private reasoning", type: "thinking" },
          contentIndex: 0,
          type: "block",
        },
        {
          block: { text: "B", type: "text" },
          contentIndex: 1,
          type: "text_start",
        },
      ],
      type: "message_update",
      usage: fauxAssistantMessage("").usage,
    }),
    ""
  );
});

test("a new primary run resets a snapshot with the same timestamp and attempt", () => {
  const project = createProvisionalTextProjection();
  const first = idFromNumber<SubmissionId>(1);
  const second = idFromNumber<SubmissionId>(2);
  const initial = snapshot("First");
  const following = snapshot("Second");
  assert.equal(project({ ...initial, run: { inputs: [first] } }), "First");
  assert.equal(project({ ...initial, run: { inputs: [first, second] } }), "");
  assert.equal(project({ ...following, run: { inputs: [second] } }), "Second");
});

test("visible thinking deltas exclude opaque signatures and redacted content", () => {
  const project = createProvisionalTextProjection("thinking");
  assert.equal(
    project({
      message: {
        ...fauxAssistantMessage(""),
        content: [
          {
            thinking: "Visible",
            thinkingSignature: "opaque-private-signature",
            type: "thinking",
          },
        ],
      },
      type: "message_start",
    }),
    "Visible"
  );
  assert.equal(
    project({
      changes: [{ contentIndex: 0, delta: " thought", type: "thinking_delta" }],
      type: "message_update",
      usage: fauxAssistantMessage("").usage,
    }),
    " thought"
  );
  assert.equal(
    project({
      message: {
        ...fauxAssistantMessage(""),
        content: [
          {
            redacted: true,
            thinking: "encrypted payload",
            thinkingSignature: "opaque-private-signature",
            type: "thinking",
          },
        ],
      },
      type: "message_start",
    }),
    ""
  );
});
