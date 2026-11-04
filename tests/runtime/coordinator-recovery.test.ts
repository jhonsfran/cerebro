import assert from "node:assert/strict";
import { test } from "node:test";

import { InvalidInput } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import {
  SourceOperations,
  WorkLedger,
  coordinatorOperationKey,
} from "../../packages/runtime/src/coordinator-ledger.ts";
import { context, setup } from "./coordinator-fixture.ts";

test("working state is bounded and cancellation has capacity when updates cannot drain", async () => {
  const fixture = await setup();
  try {
    fixture.hold();
    await fixture.invoke(
      "a",
      "start_team",
      { goal: "g".repeat(16_000) },
      "start"
    );
    const initial = await fixture.work("a");
    const { coordinator } = fixture.source("a");
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        coordinator.admissions.commit(`update-${index}`, (tx) =>
          coordinator.commandIn(
            tx,
            initial.admission.key.workId,
            `update-${index}`,
            {
              kind: "input",
              text: `Update ${index}.`,
              contentDependencies: { sourceIds: [], toolIds: [] },
            }
          )
        )
      )
    );
    const full = await fixture.work("a");
    assert.equal(Object.keys(full.pendingCommands).length, 7);
    await assert.rejects(
      coordinator.admissions.commit("overflow", (tx) =>
        coordinator.commandIn(tx, initial.admission.key.workId, "overflow", {
          kind: "input",
          text: "Overflow.",
          contentDependencies: { sourceIds: [], toolIds: [] },
        })
      ),
      (error: unknown) =>
        error instanceof InvalidInput &&
        error.reason === "This work already has its maximum pending commands."
    );
    await fixture.invoke(
      "a",
      "stop_work",
      { workId: initial.admission.key.workId },
      "stop"
    );
    const canceled = await fixture.work("a");
    assert.equal(Object.keys(canceled.pendingCommands).length, 8);
    const index = await fixture.pi().snapshot(WorkLedger, context);
    const record = await fixture.work("a");
    assert.ok(JSON.stringify(index).length < 2000);
    assert.equal(JSON.stringify(index).includes("g".repeat(100)), false);
    assert.equal(JSON.stringify(record).split("g".repeat(16_000)).length, 2);
    assert.equal(JSON.stringify(record).includes("Update 0."), false);
    fixture.release();
    await fixture.waitDispatch();
    const drained = await fixture.work("a");
    assert.deepEqual(drained.pendingCommands, {});
  } finally {
    await fixture.close();
  }
});

test("source route receipts and original dependency snapshots survive completion and replay", async () => {
  const fixture = await setup();
  try {
    await fixture.invoke(
      "a",
      "start_team",
      { goal: "Private analysis." },
      "start"
    );
    const work = await fixture.work("a");
    assert.deepEqual(work.admission.contentDependencies, {
      sourceIds: ["source-A"],
      toolIds: ["tool-A"],
    });
    const update = {
      kind: "input",
      text: "Private update.",
      contentDependencies: {
        sourceIds: [id.source("source-B")],
        toolIds: ["tool-B"],
      },
    } as const;
    await fixture
      .source("a")
      .coordinator.admissions.commit("human-update", (tx) =>
        fixture
          .source("a")
          .coordinator.commandIn(
            tx,
            work.admission.key.workId,
            "human-update",
            update
          )
      );
    await fixture.waitDispatch();
    const sent = fixture.delivered.find((command) => command.kind === "input");
    assert.ok(sent && sent.kind === "input");
    assert.deepEqual(sent.contentDependencies, update.contentDependencies);
    await fixture.report("a", "complete");
    await fixture.reopen();
    await fixture
      .source("a")
      .coordinator.rememberHumanOperation("human-update");
    const replay = await fixture
      .source("a")
      .coordinator.admissions.commit("human-update", (tx) =>
        fixture
          .source("a")
          .coordinator.commandIn(
            tx,
            work.admission.key.workId,
            "human-update",
            {
              ...update,
              contentDependencies: {
                sourceIds: [id.source("source-C")],
                toolIds: ["tool-C"],
              },
            }
          )
      );
    assert.equal(replay.accepted, false);
    await fixture.waitDispatch();
    assert.equal(
      fixture.delivered.filter((command) => command.kind === "input").length,
      1
    );
    const route = await fixture
      .pi()
      .snapshot(
        SourceOperations,
        fixture.source("a").native.id,
        await coordinatorOperationKey("human-update"),
        context
      );
    assert.deepEqual(route?.route, {
      kind: "team",
      workId: work.admission.key.workId,
      commandId: sent.id,
    });
    await assert.rejects(
      fixture
        .source("a")
        .coordinator.admissions.commit("human-update", (tx) =>
          fixture
            .source("a")
            .coordinator.commandIn(
              tx,
              work.admission.key.workId,
              "human-update",
              { ...update, text: "Changed input." }
            )
        ),
      (error: unknown) =>
        error instanceof InvalidInput &&
        error.reason === "The team command ID names another input."
    );
  } finally {
    await fixture.close();
  }
});

test("a wake before admission stays armed across reopen and failed duplicate attempts keep independent leases", async () => {
  const fixture = await setup();
  try {
    const first = await fixture
      .source("a")
      .coordinator.admissions.arm("same-operation");
    const second = await fixture
      .source("a")
      .coordinator.admissions.arm("same-operation");
    assert.notEqual(first, second);
    assert.deepEqual(await fixture.source("a").coordinator.wake(), {
      rescheduleAt: fixture.now() + 5000,
    });
    await fixture.reopen();
    assert.equal(
      await fixture.source("a").coordinator.admissions.pending(),
      true
    );
    await fixture
      .pi()
      .commit(
        (tx) => fixture.source("a").coordinator.admissions.finishIn(tx, first),
        context
      );
    assert.equal(
      await fixture.source("a").coordinator.admissions.pending(),
      true
    );
    await assert.rejects(
      fixture
        .source("a")
        .coordinator.admissions.commit("same-operation", () =>
          Promise.reject(new Error("Interrupted duplicate attempt"))
        ),
      /Interrupted duplicate attempt/u
    );
    assert.equal(
      await fixture.source("a").coordinator.admissions.pending(),
      true
    );
    await fixture.invoke(
      "a",
      "start_team",
      { goal: "Recovered work." },
      "start"
    );
    await fixture.waitDispatch();
    const work = await fixture.work("a");
    const current = fixture.source("a");
    const commandLease =
      await current.coordinator.admissions.arm("queued-update");
    await current.coordinator.wake();
    await fixture.pi().commit(async (tx) => {
      await current.coordinator.commandIn(
        tx,
        work.admission.key.workId,
        "queued-update",
        {
          kind: "input",
          text: "Recover after commit.",
          contentDependencies: { sourceIds: [], toolIds: [] },
        }
      );
      await current.coordinator.admissions.finishIn(tx, commandLease);
    }, context);
    await fixture.reopen();
    await fixture.source("a").coordinator.wake();
    await fixture.waitDispatch();
    assert.equal(
      fixture.delivered.filter((command) => command.kind === "input").length,
      1
    );
    await fixture
      .pi()
      .commit(
        (tx) => fixture.source("a").coordinator.admissions.finishIn(tx, second),
        context
      );
    assert.deepEqual(await fixture.source("a").coordinator.wake(), {
      rescheduleAt: work.admission.deadlineAt,
    });
  } finally {
    await fixture.close();
  }
});

test("expired admission leases roll back command writes and a new attempt can rearm", async () => {
  const fixture = await setup(1000);
  try {
    await fixture.invoke("a", "start_team", { goal: "Short work." }, "start");
    await fixture.waitDispatch();
    const work = await fixture.work("a");
    const { coordinator } = fixture.source("a");
    await assert.rejects(
      coordinator.admissions.commit("expired-operation", async (tx) => {
        await coordinator.commandIn(
          tx,
          work.admission.key.workId,
          "expired-operation",
          {
            kind: "input",
            text: "Must roll back.",
            contentDependencies: { sourceIds: [], toolIds: [] },
          }
        );
        fixture.advance(1001);
      }),
      (error: unknown) =>
        error instanceof InvalidInput && /lease expired/u.test(error.reason)
    );
    const rolledBackWork = await fixture.work("a");
    assert.deepEqual(rolledBackWork.pendingCommands, {});
    assert.equal(fixture.delivered.length, 1);
    const source = fixture.source("a");
    const rolledBack = await fixture
      .pi()
      .snapshot(
        SourceOperations,
        source.native.id,
        await coordinatorOperationKey("expired-operation"),
        context
      );
    assert.equal(rolledBack, undefined);
    assert.equal(await coordinator.admissions.pending(), false);
    await coordinator.admissions.commit("expired-operation", () =>
      Promise.resolve()
    );
    assert.equal(await coordinator.admissions.pending(), false);
  } finally {
    await fixture.close();
  }
});

test("dispatch retries stop after five sends and retain the reservation until the deadline", async () => {
  const fixture = await setup();
  try {
    fixture.fail(5);
    await fixture.invoke(
      "a",
      "start_team",
      { goal: "Queue outage." },
      "start-a"
    );
    await fixture.waitDispatch();
    const failed = await fixture.work("a");
    assert.equal(failed.status.kind, "failed");
    assert.equal(
      fixture.calls.filter(
        (command) => command.work.key.workId === failed.admission.key.workId
      ).length,
      5
    );
    await fixture.invoke("b", "start_team", { goal: "Other work." }, "start-b");
    const blocked = await fixture.invoke(
      "c",
      "start_team",
      { goal: "Blocked." },
      "start-c"
    );
    assert.match(
      blocked.snapshot.tools.at(-1)?.output ?? "",
      /maximum active teams/u
    );
    fixture.advance(600_001);
    await fixture.invoke(
      "c",
      "start_team",
      { goal: "After deadline." },
      "after-deadline"
    );
    await fixture.waitDispatch();
    const recovered = await fixture.work("c");
    assert.equal(recovered.status.kind, "accepted");
  } finally {
    await fixture.close();
  }
});
