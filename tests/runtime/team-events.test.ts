/* oxlint-disable unicorn/no-await-expression-member -- Assertions read one field of freshly awaited durable state. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { InvalidInput } from "../../packages/contracts/src/failures.ts";
import { TeamEventCommandSchema } from "../../packages/contracts/src/team-events.ts";
import { fauxAssistantMessage } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { TeamEventReceipts } from "../../packages/runtime/src/team-events.ts";
import { TeamState } from "../../packages/runtime/src/team-state.ts";
import { Receipts } from "../../packages/runtime/src/triggers.ts";
import { waitFor } from "./helpers.ts";
import {
  actor,
  admit,
  context,
  eventFor,
  setup,
  start,
  subscribe,
} from "./subscription-fixture.ts";
import { teamProvenanceFixture } from "./team-provenance-fixture.ts";

const subject = async (holdReturn = false) => {
  const source = await setup();
  const work = await start(source, "Review a bounded database recommendation.");
  const seed = await eventFor(source, "seed");
  await admit(source, seed);
  await subscribe(source, work.admission.key.workId, seed.id);
  const event = await eventFor(
    source,
    "unrelated-event",
    "a",
    undefined,
    "Tell me the planning meeting time."
  );
  await admit(source, event);
  const command = source.transports.find(
    (wire) => wire.kind === "event-command" && wire.event.id === event.id
  );
  assert.ok(command?.kind === "event-command");
  let returnHeld = holdReturn;
  const team = await teamProvenanceFixture({
    events: true,
    work: work.admission,
    sendReturn: async (delivery) => {
      if (returnHeld) {
        throw new Error("Return queue is temporarily unavailable.");
      }
      await source.triggers().receiveReturn(delivery, actor);
    },
  });
  const settle = async () => {
    const state = await team.pi().snapshot(TeamState, context);
    await Promise.all(
      Object.values(state?.pending ?? {}).map((taskId) =>
        team.pi().waitForTask(taskId, context)
      )
    );
    const native =
      state?.lead && (await team.pi().conversation(state.lead, context));
    if (native) {
      await native.waitForIdle(context);
    }
  };
  await team.runtime().receive({
    id: `start:${work.admission.key.workId}`,
    kind: "start",
    work: work.admission,
  });
  await settle();
  await team.runtime().receive(command);
  await settle();
  const invokeReturn = async (
    reason = "This event is unrelated to the assigned work.",
    worker = false,
    failCommit = false
  ) => {
    const state = await team.pi().snapshot(TeamState, context);
    assert.ok(state?.lead);
    const workerId = state.workers[0]?.nativeId;
    assert.ok(workerId);
    const [lead] = team.runtime().roles;
    assert.ok(lead);
    const tool = team.events().tool(lead.permit);
    return await tool.execute(
      { eventId: event.id, reason },
      {
        conversationId: worker ? workerId : state.lead,
        commit: (change, invocation) =>
          team.pi().commit(async (tx) => {
            const result = await change(tx);
            if (failCommit) {
              throw new Error("Return callback failed before commit.");
            }
            return result;
          }, invocation),
      },
      context
    );
  };
  const close = async () => {
    await team.close();
    await source.close();
  };
  return {
    source,
    team,
    command,
    work,
    event,
    settle,
    invokeReturn,
    close,
    releaseReturn: () => {
      returnHeld = false;
    },
  };
};

test("the lead returns a saved event through its durable outbox while original work remains active", async () => {
  const fixture = await subject();
  try {
    fixture.source
      .source("a")
      .faux.setResponses([
        fauxAssistantMessage(
          "The coordinator answers the unrelated meeting question."
        ),
      ]);
    const before = await fixture.team.read();
    await fixture.invokeReturn();
    const record = await fixture.team
      .pi()
      .snapshot(TeamEventReceipts, fixture.event.id, context);
    assert.ok(record?.record?.state.kind === "returned");
    const { taskId } = record.record.state;
    await fixture.team.pi().waitForTask(taskId, context);
    assert.equal((await fixture.source.settled(fixture.event.id)).kind, "done");
    assert.equal(fixture.team.returns.length, 1);
    assert.equal(fixture.team.returns[0]?.eventId, fixture.event.id);
    assert.equal(
      fixture.source.eventSubmissions.filter(
        (requestId) => requestId === fixture.event.id
      ).length,
      1
    );
    const after = await fixture.team.read();
    assert.equal(after.state?.phase, "running");
    assert.equal(after.state?.report, null);
    assert.equal(after.state?.modelCalls, before.state?.modelCalls);
    const ledger = await fixture.source.ledger();
    assert.equal(
      ledger.works[fixture.work.admission.key.workId]?.status.kind,
      "accepted"
    );
    await fixture.invokeReturn();
    const replay = await fixture.team
      .pi()
      .snapshot(TeamEventReceipts, fixture.event.id, context);
    assert.ok(replay?.record?.state.kind === "returned");
    assert.equal(replay.record.state.taskId, taskId);
    assert.equal(fixture.team.returns.length, 1);
    const changed = await fixture.invokeReturn("A changed return reason.");
    assert.equal(changed.isError, true);
    const oversized = await fixture.invokeReturn("x".repeat(1001));
    assert.equal(oversized.isError, true);
  } finally {
    await fixture.close();
  }
});

test("a worker cannot return a lead event and current content revocation blocks the lead", async () => {
  const fixture = await subject();
  try {
    const worker = await fixture.invokeReturn(undefined, true);
    assert.equal(worker.isError, true);
    const [sourceId] = fixture.command.command.contentDependencies.sourceIds;
    assert.ok(sourceId);
    fixture.team.denySource(sourceId);
    const revoked = await fixture.invokeReturn();
    assert.equal(revoked.isError, true);
    const record = await fixture.team
      .pi()
      .snapshot(TeamEventReceipts, fixture.event.id, context);
    assert.equal(record?.record?.state.kind, "admitted");
    assert.equal(fixture.team.returns.length, 0);
  } finally {
    await fixture.close();
  }
});

test("return callback rollback leaves no receipt or outbox and a retry creates one return", async () => {
  const fixture = await subject();
  try {
    fixture.source
      .source("a")
      .faux.setResponses([
        fauxAssistantMessage("The coordinator resumes after return retry."),
      ]);
    const rolledBack = await fixture.invokeReturn(undefined, false, true);
    assert.equal(rolledBack.isError, true);
    const failed = await fixture.team
      .pi()
      .snapshot(TeamEventReceipts, fixture.event.id, context);
    assert.equal(failed?.record?.state.kind, "admitted");
    assert.equal(fixture.team.returns.length, 0);
    await fixture.invokeReturn();
    const accepted = await fixture.team
      .pi()
      .snapshot(TeamEventReceipts, fixture.event.id, context);
    assert.ok(accepted?.record?.state.kind === "returned");
    await fixture.team.pi().waitForTask(accepted.record.state.taskId, context);
    assert.equal(fixture.team.returns.length, 1);
  } finally {
    await fixture.close();
  }
});

test("changed event metadata under the same command ID is rejected", async () => {
  const fixture = await subject();
  try {
    const changed = Schema.decodeUnknownSync(TeamEventCommandSchema)({
      ...fixture.command,
      event: { ...fixture.command.event, reply: null },
    });
    await assert.rejects(
      fixture.team.runtime().receive(changed),
      (error: unknown) =>
        error instanceof InvalidInput &&
        error.reason.includes("command ID names another payload")
    );
    const record = await fixture.team
      .pi()
      .snapshot(TeamEventReceipts, fixture.event.id, context);
    assert.equal(record?.record?.command.event.reply?.kind, "slack");
    assert.equal(record?.record?.state.kind, "admitted");
  } finally {
    await fixture.close();
  }
});

test("a newly arriving event at terminal work saves a return before rejection is acknowledged", async () => {
  const fixture = await subject();
  try {
    const next = await eventFor(fixture.source, "late-event");
    const sourceReceipt = await admit(fixture.source, next);
    assert.ok(sourceReceipt.route.kind === "teams");
    const late = fixture.source.transports.find(
      (wire) => wire.kind === "event-command" && wire.event.id === next.id
    );
    assert.ok(late?.kind === "event-command");
    await fixture.team.pi().commit(async (tx) => {
      const state = await tx.doc(TeamState);
      state.phase = "completed";
    }, context);
    fixture.source
      .source("a")
      .faux.setResponses([
        fauxAssistantMessage("The coordinator handles the late event."),
      ]);
    const receipt = await fixture.team.runtime().receive(late);
    assert.equal(receipt.kind, "rejected");
    const record = await fixture.team
      .pi()
      .snapshot(TeamEventReceipts, next.id, context);
    assert.ok(record?.record?.state.kind === "returned");
    await fixture.team.pi().waitForTask(record.record.state.taskId, context);
    assert.equal((await fixture.source.settled(next.id)).kind, "done");
    assert.equal(
      fixture.team.returns.filter((value) => value.eventId === next.id).length,
      1
    );
    const again = await fixture.team.runtime().receive(late);
    assert.deepEqual(again, receipt);
    assert.equal(
      fixture.team.returns.filter((value) => value.eventId === next.id).length,
      1
    );
  } finally {
    await fixture.close();
  }
});

test("a saved return outbox reopens and delivers once without a new role model request", async () => {
  const fixture = await subject(true);
  try {
    fixture.source
      .source("a")
      .faux.setResponses([
        fauxAssistantMessage("The coordinator receives the recovered return."),
      ]);
    const calls = fixture.team.calls.length;
    await fixture.invokeReturn();
    const accepted = await fixture.team
      .pi()
      .snapshot(TeamEventReceipts, fixture.event.id, context);
    assert.ok(accepted?.record?.state.kind === "returned");
    const { taskId } = accepted.record.state;
    await waitFor(
      () => fixture.team.pi().commit((tx) => tx.task(taskId), context),
      (task) =>
        task !== undefined &&
        task.state.status !== "terminal" &&
        Schema.is(Schema.Struct({ phase: Schema.Literal("retry") }))(
          task.state.checkpoint
        ),
      5000
    );
    fixture.releaseReturn();
    await fixture.team.reopen();
    await fixture.team.pi().waitForTask(taskId, context);
    const restored = await fixture.team
      .pi()
      .snapshot(TeamEventReceipts, fixture.event.id, context);
    assert.ok(restored?.record?.state.kind === "returned");
    assert.equal(restored.record.state.taskId, taskId);
    assert.equal(fixture.team.calls.length, calls);
    assert.equal(fixture.team.returns.length, 1);
    assert.equal((await fixture.source.settled(fixture.event.id)).kind, "done");
    assert.equal(
      fixture.source.eventSubmissions.filter(
        (requestId) => requestId === fixture.event.id
      ).length,
      1
    );
  } finally {
    await fixture.close();
  }
});

test("private return reasoning stays out of queue wire, source receipts, event pages and model context", async () => {
  const fixture = await subject();
  try {
    const reason = "PRIVATE_ONLY_ROUTING_REASON_FROM_LEAD_CONTEXT";
    fixture.source
      .source("a")
      .faux.setResponses([
        fauxAssistantMessage(
          "The coordinator receives the original user event."
        ),
      ]);
    await fixture.invokeReturn(reason);
    const privateRecord = await fixture.team
      .pi()
      .snapshot(TeamEventReceipts, fixture.event.id, context);
    assert.ok(privateRecord?.record?.state.kind === "returned");
    assert.equal(privateRecord.record.state.reason, reason);
    assert.equal(
      JSON.stringify(privateRecord.record.state.delivery).includes(reason),
      false
    );
    await fixture.team
      .pi()
      .waitForTask(privateRecord.record.state.taskId, context);
    assert.equal(fixture.team.returns.length, 1);
    assert.equal(JSON.stringify(fixture.team.returns).includes(reason), false);
    assert.equal((await fixture.source.settled(fixture.event.id)).kind, "done");
    const source = await fixture.source
      .triggers()
      .read(fixture.event.id, actor);
    const pages = await fixture.source
      .triggers()
      .list(fixture.source.source("a").address, actor);
    const stored = await fixture.source
      .pi()
      .snapshot(Receipts, fixture.event.id, context);
    assert.equal(JSON.stringify(source).includes(reason), false);
    assert.equal(JSON.stringify(pages).includes(reason), false);
    assert.equal(JSON.stringify(stored).includes(reason), false);
    assert.equal(
      JSON.stringify(
        await fixture.source.source("a").native.context(context)
      ).includes(reason),
      false
    );
  } finally {
    await fixture.close();
  }
});
