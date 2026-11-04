import assert from "node:assert/strict";
import { test } from "node:test";

import { Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { UserEntry } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import type { applyCoordinatorReport } from "../../packages/runtime/src/coordinator-ledger.ts";
import { requireCoordinatorWork } from "../../packages/runtime/src/coordinator-ledger.ts";
import { context, setup } from "./coordinator-fixture.ts";
import { waitFor } from "./helpers.ts";

test("two Slack scopes share identity slots, keep destinations across reopen, and reject foreign work", async () => {
  const fixture = await setup();
  try {
    await Promise.all([
      fixture.invoke("a", "start_team", { goal: "Analyze A." }, "human-A"),
      fixture.invoke("b", "start_team", { goal: "Analyze B." }, "human-B"),
    ]);
    await fixture.waitDispatch();
    assert.deepEqual(
      fixture.delivered
        .map((command) => command.work.sourceEventAddress.sessionId)
        .toSorted(),
      ["source-a", "source-b"]
    );
    const first = await fixture.work("a");
    const second = await fixture.work("b");
    assert.notEqual(first.admission.key.workId, second.admission.key.workId);
    const denied = await fixture.invoke(
      "c",
      "start_team",
      { goal: "Analyze C." },
      "human-C"
    );
    assert.match(
      denied.snapshot.tools.at(-1)?.output ?? "",
      /maximum active teams/u
    );
    const fullLedger = await fixture.ledger();
    assert.equal(Object.keys(fullLedger.works).length, 2);
    await fixture.reopen();
    const wrong = await fixture.invoke(
      "a",
      "stop_work",
      { workId: second.admission.key.workId },
      "wrong-source"
    );
    assert.match(
      wrong.snapshot.tools.at(-1)?.output ?? "",
      /another Slack source/u
    );
    await assert.rejects(
      fixture.pi().commit(
        (tx) =>
          requireCoordinatorWork(
            tx,
            {
              ...fixture.source("a"),
              ownerPrincipalId: id.principal("owner-B"),
            },
            first.admission.key.workId
          ),
        context
      ),
      (error: unknown) =>
        error instanceof Denied &&
        error.reason === "The work ledger belongs to another identity."
    );
    await fixture.invoke(
      "a",
      "message_team",
      { workId: first.admission.key.workId, text: "Update A." },
      "message-A"
    );
    await fixture.invoke(
      "b",
      "message_team",
      { workId: second.admission.key.workId, text: "Update B." },
      "message-B"
    );
    await fixture.waitDispatch();
    assert.deepEqual(
      fixture.delivered
        .filter((command) => command.kind === "input")
        .map((command) => [
          command.work.sourceEventAddress.sessionId,
          command.kind === "input" ? command.text : "",
        ]),
      [
        ["source-a", "Update A."],
        ["source-b", "Update B."],
      ]
    );
  } finally {
    await fixture.close();
  }
});

test("team acceptance completes while transport waits and native dispatch retries keep command identities after reopen", async () => {
  const fixture = await setup();
  try {
    fixture.hold();
    const accepted = await fixture.invoke(
      "a",
      "start_team",
      { goal: "Do bounded work." },
      "human-1",
      true,
      2
    );
    assert.equal(accepted.settled.status, "done");
    const initial = await fixture.work("a");
    assert.equal(Object.keys(initial.pendingCommands).length, 1);
    assert.equal(fixture.delivered.length, 0);
    assert.equal(
      fixture.jobs.get("cerebro-coordination:source-a")?.fn,
      "cerebro-coordination"
    );
    fixture.release();
    await fixture.waitDispatch();
    fixture.fail(1);
    await fixture.invoke(
      "a",
      "message_team",
      { workId: initial.admission.key.workId, text: "Retain this command." },
      "human-2"
    );
    const failed = await waitFor(
      () => fixture.calls.find((command) => command.kind === "input"),
      (command) => command !== undefined,
      1000
    );
    assert.ok(failed);
    await fixture.reopen();
    await fixture.source("a").coordinator.wake();
    await fixture.waitDispatch();
    const retried = fixture.delivered.find(
      (command) => command.kind === "input"
    );
    assert.deepEqual(retried, failed);
    const reopened = await fixture.work("a");
    assert.equal(reopened.admission.key.workId, initial.admission.key.workId);
    const wake = await fixture.source("a").coordinator.wake();
    assert.deepEqual(wake, { rescheduleAt: initial.admission.deadlineAt });
  } finally {
    await fixture.close();
  }
});

test("cancel is absorbing and retains its slot until a terminal team receipt", async () => {
  const fixture = await setup();
  try {
    await fixture.invoke("a", "start_team", { goal: "A." }, "start-A");
    await fixture.invoke("b", "start_team", { goal: "B." }, "start-B");
    const initial = await fixture.work("a");
    await fixture.invoke(
      "a",
      "stop_work",
      { workId: initial.admission.key.workId },
      "stop-A"
    );
    const blocked = await fixture.invoke(
      "c",
      "start_team",
      { goal: "C." },
      "blocked-C"
    );
    assert.match(
      blocked.snapshot.tools.at(-1)?.output ?? "",
      /maximum active teams/u
    );
    let disclosures = 0;
    const report = await fixture.report("a", "late-report", () => {
      disclosures += 1;
      return Promise.resolve();
    });
    assert.equal(report.accepted, false);
    assert.equal(report.status.kind, "cancelled");
    assert.equal(disclosures, 0);
    const update = await fixture.invoke(
      "a",
      "message_team",
      { workId: initial.admission.key.workId, text: "Late input." },
      "late-input"
    );
    assert.match(
      update.snapshot.tools.at(-1)?.output ?? "",
      /no longer accepts input/u
    );
    await fixture.invoke(
      "c",
      "start_team",
      { goal: "C after release." },
      "new-C"
    );
    const afterRelease = await fixture.ledger();
    assert.equal(Object.keys(afterRelease.works).length, 3);
    await fixture.waitDispatch();
    assert.equal(
      fixture.delivered.filter((command) => command.kind === "cancel").length,
      1
    );
  } finally {
    await fixture.close();
  }
});

test("report admission is atomic and internal runs cannot create teams while new human requests can", async () => {
  const fixture = await setup();
  try {
    await fixture.invoke(
      "a",
      "start_team",
      { goal: "Original." },
      "original-human"
    );
    const original = await fixture.work("a");
    const append = async (tx: Parameters<typeof applyCoordinatorReport>[0]) => {
      await tx.appendEntry(UserEntry, fixture.source("a").native.id, {
        model: [
          {
            role: "user",
            content: "Passive team report.",
            timestamp: fixture.now(),
          },
        ],
      });
    };
    await assert.rejects(
      fixture.report("a", "report-A", async (tx) => {
        await append(tx);
        throw new Error("Interrupted report commit");
      }),
      /Interrupted report commit/u
    );
    const afterRollback = await fixture.work("a");
    assert.equal(afterRollback.reportId, null);
    const before = await fixture.source("a").native.context(context);
    assert.equal(
      before.messages.some(
        (message) =>
          message.role === "user" && message.content === "Passive team report."
      ),
      false
    );
    const completed = await fixture.report("a", "report-A", append);
    assert.equal(completed.status.kind, "completed");
    const duplicate = await fixture.report("a", "report-A", () =>
      Promise.reject(new Error("Duplicate report must not write"))
    );
    assert.equal(duplicate.accepted, false);
    const denied = await fixture.invoke(
      "a",
      "start_team",
      { goal: "Report spawned this." },
      "internal-report-run",
      false
    );
    assert.match(
      denied.snapshot.tools.at(-1)?.output ?? "",
      /current human request/u
    );
    const afterInternalRun = await fixture.ledger();
    assert.equal(Object.keys(afterInternalRun.works).length, 1);
    fixture.setPinVersion(2);
    await fixture.invoke(
      "a",
      "start_team",
      { goal: "New human work." },
      "new-human"
    );
    const latest = await fixture.work("a");
    assert.notEqual(latest.admission.key.workId, original.admission.key.workId);
    assert.equal(latest.admission.lead.agentVersion, 2);
    const ledger = await fixture.ledger();
    assert.equal(
      ledger.works[original.admission.key.workId]?.admission.lead.agentVersion,
      1
    );
    await fixture.waitDispatch();
  } finally {
    await fixture.close();
  }
});

test("current source revocation blocks new dispatch and deadlines release only expired slots", async () => {
  const fixture = await setup();
  try {
    await fixture.invoke("a", "start_team", { goal: "A." }, "request-A");
    await fixture.invoke("b", "start_team", { goal: "B." }, "request-B");
    await fixture.waitDispatch();
    fixture.revoke("a");
    const initial = await fixture.work("a");
    const denied = await fixture.invoke(
      "a",
      "message_team",
      { workId: initial.admission.key.workId, text: "Revoked update." },
      "revoked-update"
    );
    assert.match(denied.snapshot.tools.at(-1)?.output ?? "", /revoked/u);
    assert.equal(fixture.delivered.length, 2);
    fixture.advance(600_001);
    await fixture.source("a").coordinator.wake();
    await fixture.source("b").coordinator.wake();
    await fixture.invoke(
      "c",
      "start_team",
      { goal: "C after deadlines." },
      "request-C"
    );
    await fixture.waitDispatch();
    const [first, second, third] = await Promise.all([
      fixture.work("a"),
      fixture.work("b"),
      fixture.work("c"),
    ]);
    assert.equal(first.status.kind, "failed");
    assert.equal(second.status.kind, "failed");
    assert.equal(third.status.kind, "accepted");
  } finally {
    await fixture.close();
  }
});
