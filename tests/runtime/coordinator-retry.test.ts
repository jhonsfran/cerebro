import assert from "node:assert/strict";
import { test } from "node:test";

import { Unavailable } from "../../packages/contracts/src/failures.ts";
import { context } from "./coordinator-fixture.ts";
import { setupRetry } from "./coordinator-retry-fixture.ts";
import { waitFor } from "./helpers.ts";

test(
  "an actual Slack Retry-After header survives SQLite reopen and prevents an early post",
  { timeout: 15_000 },
  async (t) => {
    const now = Date.now();
    t.mock.timers.enable({ apis: ["Date"], now });
    const subject = await setupRetry();
    try {
      subject.responses.push(
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "30" },
        })
      );
      const event = await subject.enqueue("retry-thirty");
      const retry = await waitFor(
        () => subject.read(event.id),
        (row) => row.delivery?.state === "retry" && row.attempts === 1
      );
      assert.deepEqual(retry.delivery, {
        state: "retry",
        text: retry.text,
        retryAt: now + 30_000,
      });
      assert.ok(retry.taskId);
      const task = await subject.fixture
        .pi()
        .commit((tx) => tx.task(retry.taskId), context);
      assert.deepEqual(task?.state.checkpoint, {
        phase: "retry",
        attempt: 1,
        until: now + 30_000,
      });
      assert.equal(await subject.hold("a"), true);
      assert.equal(await subject.hold("b"), false);
      t.mock.timers.setTime(now + 29_999);
      await subject.restart();
      assert.equal(await subject.hold("a"), true);
      const restored = await subject.read(event.id);
      assert.deepEqual(restored.delivery, retry.delivery);
      assert.deepEqual(
        subject.calls.map((call) => call.at),
        [now]
      );
      t.mock.timers.setTime(now + 30_000);
      await subject.restart();
      const sent = await waitFor(
        () => subject.read(event.id),
        (row) => row.delivery?.state === "sent" && row.attempts === 2
      );
      assert.deepEqual(subject.calls, [
        { at: now, text: sent.text },
        { at: now + 30_000, text: sent.text },
      ]);
      assert.equal(await subject.hold("a"), false);
      assert.equal(await subject.hold(), false);
      assert.equal(subject.fixture.source("a").faux.state.callCount, 0);
    } finally {
      await subject.close();
    }
  }
);

for (const seconds of [60, 120]) {
  test(`Retry-After ${seconds} reaches the reply deadline and finishes without another post`, async () => {
    const subject = await setupRetry();
    try {
      subject.responses.push(
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": String(seconds) },
        })
      );
      const event = await subject.enqueue(`expired-${seconds}`);
      const failed = await waitFor(
        () => subject.read(event.id),
        (row) => row.delivery?.state === "failed"
      );
      assert.equal(failed.attempts, 1);
      assert.equal(subject.calls.length, 1);
      assert.equal(await subject.hold("a"), false);
      await subject.restart();
      assert.equal(await subject.hold(), false);
      assert.equal(subject.calls.length, 1);
    } finally {
      await subject.close();
    }
  });
}

test("a missing retry deadline keeps old saved retry deliveries valid", async () => {
  const subject = await setupRetry();
  try {
    subject.responses.push(new Response("slow down", { status: 429 }));
    const event = await subject.enqueue("old-retry-row");
    const retry = await waitFor(
      () => subject.read(event.id),
      (row) => row.delivery?.state === "retry" && row.attempts === 1
    );
    assert.deepEqual(retry.delivery, { state: "retry", text: retry.text });
    await subject.restart();
    await waitFor(
      () => subject.read(event.id),
      (row) => row.delivery?.state === "sent"
    );
    assert.equal(subject.calls.length, 2);
    assert.equal(await subject.hold(), false);
  } finally {
    await subject.close();
  }
});

test(
  "a crash before the retry checkpoint still waits for the saved delivery deadline",
  { timeout: 15_000 },
  async (t) => {
    const now = Date.now();
    t.mock.timers.enable({ apis: ["Date"], now });
    const subject = await setupRetry();
    try {
      const event = await subject.enqueue(
        "saved-before-checkpoint",
        "a",
        now + 30_000
      );
      const record = await subject.read(event.id);
      assert.ok(record.taskId);
      const { taskId } = record;
      await waitFor(
        () => subject.fixture.pi().commit((tx) => tx.task(taskId), context),
        (task) => task?.state.checkpoint.phase === "retry"
      );
      assert.equal(subject.calls.length, 0);
      const waiting = await subject.read(event.id);
      assert.equal(waiting.attempts, 0);
      t.mock.timers.setTime(now + 30_000);
      await subject.restart();
      const sent = await waitFor(
        () => subject.read(event.id),
        (row) => row.delivery?.state === "sent"
      );
      assert.deepEqual(subject.calls, [{ at: now + 30_000, text: sent.text }]);
      assert.equal(sent.attempts, 1);
    } finally {
      await subject.close();
    }
  }
);

test(
  "the 96-reply queue keeps source-specific pending state and drains expired replies without a post",
  { timeout: 30_000 },
  async (t) => {
    const now = Date.now();
    t.mock.timers.enable({ apis: ["Date"], now });
    const subject = await setupRetry();
    try {
      for (const index of Array.from({ length: 96 }, (_, value) => value)) {
        // oxlint-disable-next-line no-await-in-loop -- Each committed reply tests the shared outbox capacity.
        await subject.enqueue(
          `bounded-${index}`,
          index % 2 === 0 ? "a" : "b",
          now + 30_000
        );
      }
      await assert.rejects(
        subject.enqueue("overflow", "b", now + 30_000),
        (error: unknown) => error instanceof Unavailable
      );
      assert.equal(await subject.hold("a"), true);
      assert.equal(await subject.hold("b"), true);
      assert.equal(subject.calls.length, 0);
      t.mock.timers.setTime(now + 61_000);
      await subject.restart();
      await waitFor(
        () => subject.hold(),
        (pending) => !pending
      );
      assert.equal(await subject.hold("a"), false);
      assert.equal(await subject.hold("b"), false);
      assert.equal(subject.calls.length, 0);
    } finally {
      await subject.close();
    }
  }
);
