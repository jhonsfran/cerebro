import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { TeamInspectionFrame } from "../../packages/contracts/src/inspection.ts";
import {
  inspectEntries,
  inspectLive,
} from "../../packages/runtime/src/inspection-native.ts";
import { occurrenceFixture } from "./inspection-occurrence-fixture.ts";

test(
  "reused provider IDs retain a successful occurrence and identify the running and pending sequential calls",
  { timeout: 15_000 },
  async () => {
    const subject = await occurrenceFixture();
    try {
      const { frame, taskReads } = await subject.read();
      assert.equal(taskReads, 1);
      assert.deepEqual(
        frame.tools.map(({ callId, status, output }) => ({
          callId,
          status,
          output,
        })),
        [
          {
            callId: "reused-call",
            status: "succeeded",
            output: { text: "Completed occurrence 1.", truncated: false },
          },
          { callId: "reused-call", status: "running", output: null },
          { callId: "pending-call", status: "pending", output: null },
        ]
      );
      assert.equal(new Set(frame.tools.map(({ id }) => id)).size, 3);
      assert.deepEqual(
        Schema.decodeUnknownSync(TeamInspectionFrame, {
          onExcessProperty: "error",
        })(frame),
        frame
      );
      const encoded = JSON.stringify(frame);
      assert.equal(encoded.includes("assistantEntryId"), false);
      assert.equal(encoded.includes("Check retained work."), true);
      const repeated = await subject.read();
      assert.deepEqual(repeated.frame, frame);
      const completed = await subject.complete();
      const settled = await subject.read();
      assert.equal(settled.taskReads, 0);
      assert.deepEqual(
        settled.frame.tools.map(({ id }) => id),
        frame.tools.map(({ id }) => id)
      );
      assert.deepEqual(
        settled.frame.tools.map(({ status }) => status),
        ["succeeded", "succeeded", "succeeded"]
      );
      assert.deepEqual(
        inspectLive(inspectEntries(completed)).tools,
        settled.frame.tools
      );
    } finally {
      await subject.close();
    }
  }
);

test(
  "an older unmatched call stays unknown when a later current round reuses its provider ID",
  { timeout: 15_000 },
  async () => {
    const subject = await occurrenceFixture();
    try {
      const first = subject.entries.find(
        (entry) => entry.kind === "pi.assistant"
      );
      assert.ok(first);
      const page = await subject.native.entries(
        { minEntryId: first.id, maxEntryId: first.id },
        1,
        undefined,
        subject.context
      );
      const projected = subject.project(page.items);
      assert.deepEqual(
        projected.tools.map(({ callId, status, output }) => ({
          callId,
          status,
          output,
        })),
        [{ callId: "reused-call", status: "unknown", output: null }]
      );
      const unproven = inspectLive(
        inspectEntries(subject.entries),
        subject.live
      );
      assert.deepEqual(
        unproven.tools.map(({ status }) => status),
        ["succeeded", "unknown", "unknown"]
      );
      const other = await subject.pi.createConversation(
        { ownership: { kind: "ownerless" } },
        subject.context
      );
      const foreign = inspectLive(
        inspectEntries(subject.entries),
        subject.live,
        { task: subject.task, conversationId: other.id }
      );
      assert.deepEqual(foreign.tools, unproven.tools);
      await subject.complete();
      const settled = await subject.pi.getTask(
        subject.task.id,
        subject.context
      );
      const stale = inspectLive(inspectEntries(subject.entries), subject.live, {
        task: settled,
        conversationId: subject.native.id,
      });
      assert.deepEqual(stale.tools, unproven.tools);
    } finally {
      await subject.close();
    }
  }
);

test(
  "result-only rows have stable occurrence IDs and cannot replace a prior completed reused call",
  { timeout: 15_000 },
  async () => {
    const subject = await occurrenceFixture({ second: ["reused-call"] });
    try {
      const entries = await subject.complete();
      const assistant = entries.find((entry) => entry.kind === "pi.assistant");
      const results = entries.filter(
        (entry) => entry.kind === "pi.tool-result"
      );
      const [first, second] = results;
      assert.ok(assistant && first && second);
      const projected = inspectLive(inspectEntries([assistant, first, second]));
      assert.deepEqual(
        projected.tools.map(({ id, callId, status, output }) => ({
          id,
          callId,
          status,
          output,
        })),
        [
          {
            id: `call:${assistant.id}:0:0`,
            callId: "reused-call",
            status: "succeeded",
            output: { text: "Completed occurrence 1.", truncated: false },
          },
          {
            id: `result:${second.id}:0`,
            callId: "reused-call",
            status: "succeeded",
            output: { text: "Completed occurrence 2.", truncated: false },
          },
        ]
      );
      const onlyResults = inspectLive(inspectEntries(results));
      assert.deepEqual(
        onlyResults.tools.map(({ id }) => id),
        [`result:${first.id}:0`, `result:${second.id}:0`]
      );
      assert.deepEqual(inspectLive(inspectEntries(results)), onlyResults);
    } finally {
      await subject.close();
    }
  }
);

test(
  "the 24-row cap keeps omitted current calls and their results from updating older reused calls",
  { timeout: 15_000 },
  async () => {
    const firstIds = Array.from({ length: 24 }, (_, index) =>
      index === 0 ? "reused-call" : `first-${index}`
    );
    const subject = await occurrenceFixture({
      first: firstIds,
      second: ["reused-call"],
    });
    try {
      const assistants = subject.entries.filter(
        (entry) =>
          entry.kind === "pi.assistant" &&
          entry.model?.some(
            (message) =>
              message.role === "assistant" && message.stopReason === "toolUse"
          )
      );
      const [first, second] = assistants;
      assert.ok(first && second);
      const active = subject.project(assistants);
      assert.equal(active.tools.length, 24);
      assert.ok(active.tools.every(({ status }) => status === "unknown"));
      const latest = await subject.read();
      assert.equal(latest.taskReads, 1);
      assert.ok(latest.frame.next);
      const old = await subject.read(latest.frame.next);
      assert.equal(old.taskReads, 0);
      const saved = await subject.complete();
      const results = saved.filter((entry) => entry.kind === "pi.tool-result");
      const [firstResult] = results;
      const secondResult = results.at(-1);
      assert.ok(firstResult && secondResult);
      const unmatched = inspectLive(
        inspectEntries([first, second, secondResult])
      );
      assert.ok(unmatched.tools.every(({ status }) => status === "unknown"));
      const matched = inspectLive(
        inspectEntries([first, firstResult, second, secondResult])
      );
      assert.equal(matched.tools.length, 24);
      assert.equal(matched.tools[0]?.output?.text, "Completed occurrence 1.");
      assert.equal(matched.tools[0]?.resultEntryId, String(firstResult.id));
      assert.equal(matched.tools[0]?.status, "succeeded");
    } finally {
      await subject.close();
    }
  }
);

test(
  "full provider IDs remain distinct when their bounded displayed prefixes are equal",
  { timeout: 15_000 },
  async () => {
    const prefix = "p".repeat(2048);
    const subject = await occurrenceFixture({
      first: ["setup"],
      second: [`${prefix}-first`, `${prefix}-second`],
      holdSecondAt: 2,
    });
    try {
      const active = await subject.read();
      assert.equal(active.taskReads, 1);
      assert.deepEqual(
        active.frame.tools.map(({ callId, status }) => ({ callId, status })),
        [
          { callId: "setup", status: "succeeded" },
          { callId: prefix, status: "succeeded" },
          { callId: prefix, status: "running" },
        ]
      );
      assert.equal(new Set(active.frame.tools.map(({ id }) => id)).size, 3);
      assert.equal(
        active.frame.tools[1]?.output?.text,
        "Completed occurrence 2."
      );
      assert.deepEqual(
        Schema.decodeUnknownSync(TeamInspectionFrame, {
          onExcessProperty: "error",
        })(active.frame),
        active.frame
      );
      const encoded = JSON.stringify(active.frame);
      assert.equal(encoded.includes(`${prefix}-first`), false);
      assert.equal(encoded.includes(`${prefix}-second`), false);
      await subject.complete();
      const completed = await subject.read();
      assert.deepEqual(
        completed.frame.tools.map(({ output }) => output?.text),
        [
          "Completed occurrence 1.",
          "Completed occurrence 2.",
          "Completed occurrence 3.",
        ]
      );
    } finally {
      await subject.close();
    }
  }
);
