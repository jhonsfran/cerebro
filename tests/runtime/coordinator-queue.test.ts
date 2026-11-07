/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Durable admissions, queue transitions, and page cursors depend on the previous operation. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { Denied } from "../../packages/contracts/src/failures.ts";
import { WorkReportSchema } from "../../packages/contracts/src/work.ts";
import {
  applyCoordinatorReport,
  WorkDocuments,
  WorkLedger,
} from "../../packages/runtime/src/coordinator-ledger.ts";
import { wakeCoordinatorJob } from "../../packages/runtime/src/coordinator-work.ts";
import { context, setup } from "./coordinator-fixture.ts";

const toolValue = (
  result: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["invoke"]>>
) => JSON.parse(result.snapshot.tools.at(-1)?.output ?? "{}");

test("two starts in one human turn are independent and replay keeps their admissions and role pins", async () => {
  const f = await setup();
  try {
    await f.invoke(
      "a",
      "start_team",
      { goal: "Independent." },
      "same-turn",
      true,
      2
    );
    await f.waitDispatch();
    const initial = await f.ledger();
    const ids = Object.keys(initial.works);
    assert.equal(ids.length, 2);
    assert.equal(new Set(ids).size, 2);
    assert.equal(f.delivered.length, 2);
    const cause = await f.webTrigger("a", "same-turn");
    assert.ok(
      Object.values(initial.works).every(
        (record) => record.humanOperationId === cause.id
      )
    );
    f.setPinVersion(2);
    await f.reopen();
    await f.invoke(
      "a",
      "start_team",
      { goal: "Independent." },
      "same-turn",
      true,
      2
    );
    const replayed = await f.ledger();
    assert.deepEqual(replayed.works, initial.works);
    assert.equal(f.delivered.length, 2);
    const third = toolValue(
      await f.invoke(
        "a",
        "start_team",
        { goal: "Another goal." },
        "another-turn"
      )
    );
    assert.equal(third.status.kind, "queued");
    assert.ok(!ids.includes(third.workId));
    assert.equal((await f.work("a")).admission.agent.agentVersion, 2);
  } finally {
    await f.close();
  }
});

test("one owner has two active teams and sixteen queued items across sources with explicit atomic overflow", async () => {
  const f = await setup();
  try {
    for (let index = 0; index < 18; index += 1) {
      await f.invoke(
        ["a", "b", "c"][index % 3] ?? "a",
        "start_team",
        { goal: `Goal ${index}.` },
        `capacity-${index}`
      );
    }
    await f.waitDispatch();
    const before = await f.ledger();
    assert.equal(Object.keys(before.active).length, 2);
    assert.equal(before.queue.length, 16);
    assert.equal(Object.keys(before.works).length, 18);
    assert.equal(f.delivered.length, 2);
    const overflow = await f.invoke(
      "b",
      "start_team",
      { goal: "Overflow." },
      "overflow"
    );
    assert.match(
      overflow.snapshot.tools.at(-1)?.output ?? "",
      /maximum sixteen queued work items/u
    );
    const after = await f.ledger();
    assert.deepEqual(after.works, before.works);
    assert.equal(after.documents, before.documents);
    assert.deepEqual(after.active, before.active);
    assert.deepEqual(after.queue, before.queue);
    assert.equal(f.calls.length, 2);
    assert.equal(
      JSON.stringify(await f.source("c").coordinator.wake()).includes(
        "rescheduleAt"
      ),
      true
    );
  } finally {
    await f.close();
  }
});

test("queued cancellation and expiry create no Team commands and queued updates stay bounded and targeted", async () => {
  const f = await setup(1000);
  try {
    await f.invoke("a", "start_team", { goal: "Active A." }, "active-a");
    await f.invoke("b", "start_team", { goal: "Active B." }, "active-b");
    const queued = toolValue(
      await f.invoke("c", "start_team", { goal: "Wait." }, "queued")
    );
    await f.waitDispatch();
    const { coordinator } = f.source("c");
    for (let index = 0; index < 6; index += 1) {
      const updated = toolValue(
        await f.invoke(
          "c",
          "message_team",
          { workId: queued.workId, text: `Update ${index}.` },
          `update-${index}`
        )
      );
      assert.equal(updated.accepted, true);
    }
    const overflow = await f.invoke(
      "c",
      "message_team",
      { workId: queued.workId, text: "Overflow." },
      "update-overflow"
    );
    assert.match(
      overflow.snapshot.tools.at(-1)?.output ?? "",
      /maximum pending updates/u
    );
    const record = await f.work("c");
    assert.equal(Object.keys(record.queuedCommands).length, 6);
    assert.equal(Object.keys(record.pendingCommands).length, 0);
    assert.equal(f.calls.length, 2);
    assert.equal(
      (
        await coordinator.cancel({
          workId: queued.workId,
          operationId: "cancel-queued",
        })
      ).accepted,
      true
    );
    assert.equal(
      (
        await coordinator.cancel({
          workId: queued.workId,
          operationId: "cancel-queued",
        })
      ).accepted,
      false
    );
    assert.equal((await f.work("c")).status.kind, "cancelled");
    assert.equal((await f.ledger()).queue.length, 0);
    assert.equal(f.calls.length, 2);
    const expired = toolValue(
      await f.invoke(
        "c",
        "start_team",
        { goal: "Expires while waiting." },
        "expires"
      )
    );
    const deadline = expired.deadlineAt;
    await f.reopen();
    f.advance(1001);
    await f.source("c").coordinator.wake();
    const saved = await f.pi().snapshot(WorkDocuments, expired.workId, context);
    assert.equal(saved?.record?.status.kind, "failed");
    assert.equal(saved?.record?.admission.deadlineAt, deadline);
    assert.equal(saved?.record?.dispatched, false);
    assert.equal(
      f.calls.some((command) => command.work.key.workId === expired.workId),
      false
    );
    assert.equal((await f.ledger()).queue.length, 0);
  } finally {
    await f.close();
  }
});

test("global FIFO survives wrong-source and concurrent wakes, promotion, queued updates, and reopen", async () => {
  const f = await setup();
  try {
    await f.invoke("a", "start_team", { goal: "Active A." }, "active-a");
    const activeA = await f.work("a");
    await f.invoke("b", "start_team", { goal: "Active B." }, "active-b");
    const head = toolValue(
      await f.invoke("c", "start_team", { goal: "First queued." }, "head")
    );
    const tail = toolValue(
      await f.invoke("a", "start_team", { goal: "Second queued." }, "tail")
    );
    await f.invoke(
      "c",
      "message_team",
      { workId: head.workId, text: "Saved queued update." },
      "queued-update"
    );
    await f.waitDispatch();
    await f.report("a", "release-a", undefined, activeA.admission.key.workId);
    await f.reopen();
    const wrongWake = await f.source("a").coordinator.wake();
    assert.deepEqual(wrongWake, { rescheduleAt: f.now() + 5000 });
    let ledger = await f.ledger();
    assert.equal(ledger.works[tail.workId]?.status.kind, "queued");
    assert.equal(Object.keys(ledger.active).length, 1);
    const joined = toolValue(
      await f.invoke(
        "b",
        "start_team",
        { goal: "Must join FIFO." },
        "new-arrival"
      )
    );
    assert.equal(joined.status.kind, "queued");
    assert.deepEqual(
      (await f.ledger()).queue.map((entry) => entry.workId),
      [head.workId, tail.workId, joined.workId]
    );
    await Promise.all([
      f.source("a").coordinator.wake(),
      f.source("b").coordinator.wake(),
      f.source("c").coordinator.wake(),
      f.source("c").coordinator.wake(),
    ]);
    await f.waitDispatch();
    ledger = await f.ledger();
    assert.equal(Object.keys(ledger.active).length, 2);
    assert.equal(ledger.works[head.workId]?.status.kind, "accepted");
    assert.equal(ledger.works[tail.workId]?.status.kind, "queued");
    assert.equal(
      f.delivered.filter(
        (command) =>
          command.kind === "start" && command.work.key.workId === head.workId
      ).length,
      1
    );
    assert.equal(
      f.delivered.filter(
        (command) =>
          command.kind === "input" && command.work.key.workId === head.workId
      ).length,
      1
    );
    assert.ok(
      f.delivered
        .filter((command) => command.work.key.workId === head.workId)
        .every(
          (command) => command.work.sourceEventAddress.sessionId === "source-c"
        )
    );
    await f.reopen();
    await f.report("c", "release-head", undefined, head.workId);
    await Promise.all([
      f.source("a").coordinator.wake(),
      f.source("b").coordinator.wake(),
    ]);
    await f.waitDispatch();
    assert.equal(
      (await f.ledger()).works[tail.workId]?.status.kind,
      "accepted"
    );
    assert.equal(
      f.delivered.filter(
        (command) =>
          command.kind === "start" && command.work.key.workId === tail.workId
      ).length,
      1
    );
  } finally {
    await f.close();
  }
});

test("one wake fills both free slots from consecutive local FIFO heads before a short deadline", async () => {
  const f = await setup(1000);
  try {
    for (let index = 0; index < 4; index += 1) {
      await f.invoke(
        "a",
        "start_team",
        { goal: `Goal ${index}.` },
        `start-${index}`
      );
    }
    await f.waitDispatch();
    const before = await f.ledger();
    const activeIds = Object.keys(before.active);
    assert.equal(activeIds.length, 2);
    assert.equal(before.queue.length, 2);
    for (const workId of activeIds) {
      await f.report("a", `report-${workId}`, undefined, workId);
    }
    await f.source("a").coordinator.wake();
    await f.waitDispatch();
    const after = await f.ledger();
    assert.equal(Object.keys(after.active).length, 2);
    assert.equal(after.queue.length, 0);
    assert.deepEqual(
      Object.keys(after.active),
      before.queue.map((entry) => entry.workId)
    );
    assert.equal(
      f.delivered.filter((command) => command.kind === "start").length,
      4
    );
  } finally {
    await f.close();
  }
});

test("a local wake stops promotion at a foreign FIFO head with spare capacity", async () => {
  const f = await setup();
  try {
    await f.invoke("b", "start_team", { goal: "Active B1." }, "active-b1");
    await f.invoke("b", "start_team", { goal: "Active B2." }, "active-b2");
    const active = Object.keys((await f.ledger()).active);
    const head = toolValue(
      await f.invoke("a", "start_team", { goal: "Local head." }, "local-head")
    );
    const foreign = toolValue(
      await f.invoke(
        "c",
        "start_team",
        { goal: "Foreign head." },
        "foreign-head"
      )
    );
    const tail = toolValue(
      await f.invoke("a", "start_team", { goal: "Local tail." }, "local-tail")
    );
    await f.waitDispatch();
    for (const workId of active) {
      await f.report("b", `report-${workId}`, undefined, workId);
    }
    await f.source("a").coordinator.wake();
    await f.waitDispatch();
    const after = await f.ledger();
    assert.deepEqual(Object.keys(after.active), [head.workId]);
    assert.deepEqual(
      after.queue.map((entry) => entry.workId),
      [foreign.workId, tail.workId]
    );
    assert.equal(
      f.calls.some(
        (command) =>
          command.work.key.workId === foreign.workId ||
          command.work.key.workId === tail.workId
      ),
      false
    );
  } finally {
    await f.close();
  }
});

test("the normal coordination job preserves expired active work until cancellation admission", async () => {
  const f = await setup(1000);
  try {
    await f.invoke(
      "a",
      "start_team",
      { goal: "Expires after dispatch." },
      "start"
    );
    await f.waitDispatch();
    const work = await f.work("a");
    f.advance(1001);
    await wakeCoordinatorJob({
      pi: f.pi(),
      address: f.source("a").address,
      now: f.now,
      restore: () => Promise.resolve(f.source("a").coordinator),
    });
    await f.waitDispatch();
    assert.equal(
      f.delivered.filter(
        (command) =>
          command.kind === "cancel" &&
          command.work.key.workId === work.admission.key.workId
      ).length,
      1
    );
    assert.equal(Object.keys((await f.ledger()).active).length, 0);
  } finally {
    await f.close();
  }
});

test("a permanently unavailable scope keeps a wake until global expiry and creates no queued command", async () => {
  const f = await setup(1000);
  try {
    await f.invoke("a", "start_team", { goal: "A." }, "active-a");
    await f.invoke("b", "start_team", { goal: "B." }, "active-b");
    const head = toolValue(
      await f.invoke(
        "c",
        "start_team",
        { goal: "Unavailable queue head." },
        "queued-c"
      )
    );
    await f.waitDispatch();
    const job = () =>
      wakeCoordinatorJob({
        pi: f.pi(),
        address: f.source("c").address,
        now: f.now,
        restore: () =>
          Promise.reject(
            new Denied({ code: "revoked", reason: "The scope cannot restore." })
          ),
      });
    assert.deepEqual(await job(), { rescheduleAt: f.now() + 5000 });
    assert.equal((await f.ledger()).queue.length, 1);
    f.advance(1001);
    assert.equal(await job(), undefined);
    const after = await f.ledger();
    assert.equal(after.queue.length, 0);
    assert.equal(Object.keys(after.active).length, 0);
    assert.equal(after.works[head.workId]?.status.kind, "failed");
    assert.equal(
      f.calls.some((command) => command.work.key.workId === head.workId),
      false
    );
  } finally {
    await f.close();
  }
});

test("an unavailable foreign head expires and releases FIFO without source restoration", async () => {
  const f = await setup(1000);
  try {
    await f.invoke("a", "start_team", { goal: "Active." }, "active-a");
    const active = await f.work("a");
    await f.invoke("b", "start_team", { goal: "Active." }, "active-b");
    const head = toolValue(
      await f.invoke("c", "start_team", { goal: "Revoked head." }, "head")
    );
    f.advance(500);
    const tail = toolValue(
      await f.invoke("a", "start_team", { goal: "Valid tail." }, "tail")
    );
    await f.report("a", "release", undefined, active.admission.key.workId);
    f.revoke("c");
    await f.source("a").coordinator.wake();
    assert.equal((await f.ledger()).works[tail.workId]?.status.kind, "queued");
    f.advance(501);
    await f.source("a").coordinator.wake();
    await f.waitDispatch();
    const ledger = await f.ledger();
    assert.equal(ledger.works[head.workId]?.status.kind, "failed");
    assert.equal(ledger.works[tail.workId]?.status.kind, "accepted");
    assert.equal(
      ledger.works[tail.workId]?.admission.deadlineAt,
      tail.deadlineAt
    );
    assert.equal(
      f.calls.some((command) => command.work.key.workId === head.workId),
      false
    );
  } finally {
    await f.close();
  }
});

test("expiry and promotion commit together when both active slots expire", async () => {
  const f = await setup(1000);
  try {
    await f.invoke("a", "start_team", { goal: "A." }, "active-a");
    await f.invoke("a", "start_team", { goal: "B." }, "active-b");
    await f.waitDispatch();
    f.advance(500);
    const queued = toolValue(
      await f.invoke("a", "start_team", { goal: "After expiry." }, "queued")
    );
    await f.invoke(
      "a",
      "message_team",
      { workId: queued.workId, text: "Retain queued input." },
      "queued-input"
    );
    await f.reopen();
    f.advance(501);
    await f.source("a").coordinator.wake();
    await f.waitDispatch();
    const saved = await f.ledger();
    assert.equal(Object.keys(saved.active).length, 1);
    assert.equal(saved.queue.length, 0);
    assert.equal(saved.works[queued.workId]?.status.kind, "accepted");
    assert.equal(
      f.delivered.filter((command) => command.kind === "cancel").length,
      2
    );
    assert.equal(
      f.delivered.filter(
        (command) =>
          command.kind === "start" && command.work.key.workId === queued.workId
      ).length,
      1
    );
    assert.equal(
      f.delivered.filter(
        (command) =>
          command.kind === "input" && command.work.key.workId === queued.workId
      ).length,
      1
    );
  } finally {
    await f.close();
  }
});

test("uncertain active cancellation keeps its reservation until the terminal acknowledgement", async () => {
  const f = await setup();
  try {
    await f.invoke("a", "start_team", { goal: "A." }, "active-a");
    await f.invoke("b", "start_team", { goal: "B." }, "active-b");
    await f.waitDispatch();
    const active = await f.work("a");
    f.fail(5);
    await f.source("a").coordinator.cancel({
      workId: active.admission.key.workId,
      operationId: "uncertain-cancel",
    });
    await f.waitDispatch();
    assert.equal(
      f.calls.filter((command) => command.kind === "cancel").length,
      5
    );
    assert.equal((await f.work("a")).status.kind, "cancelled");
    const queued = toolValue(
      await f.invoke(
        "c",
        "start_team",
        { goal: "Wait for acknowledgement." },
        "queued"
      )
    );
    await f.source("c").coordinator.wake();
    assert.equal(
      (await f.ledger()).works[queued.workId]?.status.kind,
      "queued"
    );
    assert.equal(Object.keys((await f.ledger()).active).length, 2);
    assert.equal((await f.report("a", "cancelled-ack")).accepted, false);
    await f.source("c").coordinator.wake();
    await f.waitDispatch();
    assert.equal(
      (await f.ledger()).works[queued.workId]?.status.kind,
      "accepted"
    );
  } finally {
    await f.close();
  }
});

test("completed history pages beyond thirty-two records and recalls the oldest result after reopen", async () => {
  const f = await setup();
  try {
    const ids: string[] = [];
    for (let index = 0; index < 35; index += 1) {
      await f.invoke(
        "a",
        "start_team",
        { goal: `Completed goal ${index}.` },
        `completed-${index}`
      );
      await f.waitDispatch();
      const work = await f.work("a");
      ids.push(work.admission.key.workId);
      await f.report("a", `report-${index}`);
    }
    await f.reopen();
    const first = toolValue(await f.invoke("a", "list_work", {}, "list-first"));
    assert.equal(first.items.length, 32);
    assert.equal("total" in first, false);
    assert.ok(first.next);
    const second = toolValue(
      await f.invoke("a", "list_work", { cursor: first.next }, "list-second")
    );
    assert.equal(second.items.length, 3);
    assert.equal(second.next, undefined);
    assert.deepEqual(
      [...first.items, ...second.items].map((item) => item.workId),
      ids
    );
    const recalled = toolValue(
      await f.invoke("a", "recall_work", { workId: ids[0] }, "recall-oldest")
    );
    assert.equal(recalled.goal, "Completed goal 0.");
    assert.equal(recalled.report.text, "Team result.");
    assert.equal(recalled.report.id, "report-0");
    assert.deepEqual(recalled.report.contentDependencies, {
      sourceIds: [],
      toolIds: [],
    });
    const foreign = await f.invoke(
      "b",
      "recall_work",
      { workId: ids[0] },
      "foreign-recall"
    );
    assert.match(
      foreign.snapshot.tools.at(-1)?.output ?? "",
      /another conversation/u
    );
    const empty = toolValue(
      await f.invoke("b", "list_work", {}, "filtered-page")
    );
    assert.deepEqual(empty.items, []);
    assert.equal(empty.next, first.next);
    f.revokeContent("source-A");
    const denied = await f.invoke(
      "a",
      "recall_work",
      { workId: ids[0] },
      "revoked-recall"
    );
    assert.match(
      denied.snapshot.tools.at(-1)?.output ?? "",
      /Content access revoked/u
    );
    const deniedList = await f.invoke("a", "list_work", {}, "revoked-list");
    assert.match(
      deniedList.snapshot.tools.at(-1)?.output ?? "",
      /Content access revoked/u
    );
    assert.equal(
      Object.keys((await f.pi().snapshot(WorkLedger, context))?.active ?? {})
        .length,
      0
    );
  } finally {
    await f.close();
  }
});

test("recall bounds terminal text and checks the saved result dependencies", async () => {
  const f = await setup();
  try {
    await f.invoke("a", "start_team", { goal: "Recall result." }, "start");
    await f.waitDispatch();
    const work = await f.work("a");
    const report = Schema.decodeUnknownSync(WorkReportSchema)({
      kind: "completed",
      id: "bounded-report",
      key: work.admission.key,
      contentDependencies: { sourceIds: ["source-B"], toolIds: ["tool-B"] },
      text: "r".repeat(16_000),
    });
    await f
      .pi()
      .commit(
        (tx) =>
          applyCoordinatorReport(
            tx,
            f.source("a"),
            report,
            () => Promise.resolve(),
            f.now()
          ),
        context
      );
    await f.reopen();
    const recalled = toolValue(
      await f.invoke(
        "a",
        "recall_work",
        { workId: work.admission.key.workId },
        "recall"
      )
    );
    assert.equal(recalled.report.text.length, 4000);
    assert.deepEqual(recalled.report.contentDependencies, {
      sourceIds: ["source-B"],
      toolIds: ["tool-B"],
    });
    f.revokeContent("source-B");
    const denied = await f.invoke(
      "a",
      "recall_work",
      { workId: work.admission.key.workId },
      "revoked-result"
    );
    assert.match(
      denied.snapshot.tools.at(-1)?.output ?? "",
      /Content access revoked/u
    );
  } finally {
    await f.close();
  }
});
