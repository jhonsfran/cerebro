import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Schema } from "effect";

import { Conflict, Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import {
  TeamReportDeliverySchema,
  WorkAdmissionSchema,
} from "../../packages/contracts/src/work.ts";
import { fauxAssistantMessage } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { BotEventQueue } from "../../packages/runtime/src/coordinator-events.ts";
import {
  WorkDocuments,
  coordinatorOperationKey,
} from "../../packages/runtime/src/coordinator-ledger.ts";
import {
  createCoordinatorReport,
  SourceReportReceipts,
} from "../../packages/runtime/src/coordinator-report.ts";
import { createCoordinatorSource } from "../../packages/runtime/src/coordinator-source.ts";
import {
  ImportedContent,
  readImportedContent,
} from "../../packages/runtime/src/imported-content.ts";
import { chatPresentation } from "../../packages/runtime/src/pi-harness.ts";
import { context, setup } from "./coordinator-fixture.ts";

const actor = {
  actor: {
    id: id.principal("owner-A"),
    organizationId: id.organization("org-A"),
    kind: "human" as const,
    state: "active" as const,
  },
};
const subject = async () => {
  const fixture = await setup();
  await fixture.invoke("a", "start_team", { goal: "Read A." }, "first-human");
  await fixture.waitDispatch();
  const source = fixture.source("a");
  const { services } = source.coordinator;
  assert.ok(services);
  let allowed = true;
  let importFails = false;
  let eventFails = false;
  let importedAllowed = true;
  let notifyFails = false;
  let notifications = 0;
  const runtime = {
    authorize: () => {
      if (!allowed) {
        throw new Denied({ code: "revoked", reason: "Source revoked." });
      }
      return Promise.resolve();
    },
    configuration: {
      coordination: services,
      provider: { model: source.faux.getModel() },
      checkImportedDependencies: () =>
        importedAllowed
          ? Effect.void
          : Effect.fail(
              new Denied({
                code: "revoked",
                reason: "Imported access revoked.",
              })
            ),
      importDependencies: () => {
        if (importFails) {
          throw new Error("Import failed after native staging.");
        }
      },
    },
  };
  const notify = () => {
    notifications += 1;
    if (notifyFails) {
      throw new Error("Notification scheduling failed.");
    }
    return Promise.resolve();
  };
  const ports = {
    pi: fixture.pi(),
    native: source.native,
    runtime,
    coordination: source.coordinator,
    notify,
  };
  const receive = createCoordinatorReport({
    ...ports,
    persist: () => Promise.resolve(),
    events: {
      ...fixture.events(),
      enqueueIn: async (tx, event) => {
        const receipt = await fixture.events().enqueueIn(tx, event);
        if (eventFails) {
          throw new Error("Event intent failed after task creation.");
        }
        return receipt;
      },
    },
  });
  const route = createCoordinatorSource(ports);
  const record = await fixture.work("a");
  const delivery = Schema.decodeUnknownSync(TeamReportDeliverySchema)({
    version: 2,
    sourceEventAddress: record.admission.sourceEventAddress,
    report: {
      id: `report:${record.admission.key.workId}`,
      key: record.admission.key,
      kind: "completed",
      text: "Result based on B.",
      contentDependencies: { sourceIds: ["source-B"], toolIds: ["tool-B"] },
    },
  });
  const messages = async () => {
    const watch = await source.native.watch(context);
    try {
      return chatPresentation(watch.value).messages;
    } finally {
      await watch.stop();
    }
  };
  const settleReports = async () => {
    const page = await fixture.events().list(source.address, actor);
    await Promise.all(
      page.items.map((receipt) =>
        fixture.pi().waitForTask(receipt.taskId, context)
      )
    );
  };
  source.faux.setResponses([
    fauxAssistantMessage("Coordinator result. Result based on B."),
  ]);
  return {
    fixture,
    source,
    delivery,
    receive,
    route,
    messages,
    settleReports,
    notifications: () => notifications,
    importFails: (value: boolean) => {
      importFails = value;
    },
    eventFails: (value: boolean) => {
      eventFails = value;
    },
    notifyFails: (value: boolean) => {
      notifyFails = value;
    },
    revokeImports: () => {
      importedAllowed = false;
    },
    revoke: () => {
      allowed = false;
    },
  };
};

test("a failed report event task creation rolls back its receipt, provenance, terminal status and slot release", async () => {
  const f = await subject();
  try {
    f.eventFails(true);
    await assert.rejects(f.receive(f.delivery, actor), /Event intent failed/u);
    const work = await f.fixture.work("a");
    assert.equal(work.reportId, null);
    assert.equal(work.terminalReport, null);
    assert.equal(work.status.kind, "accepted");
    const ledger = await f.fixture.ledger();
    assert.ok(ledger.active[work.admission.key.workId]);
    assert.deepEqual(
      await readImportedContent(f.fixture.pi(), f.source.native.id),
      { sourceIds: [], toolIds: [] }
    );
    const events = await f.fixture.events().list(f.source.address, actor);
    assert.equal(events.items.length, 0);
    assert.equal(
      await f.fixture.pi().snapshot(BotEventQueue, context),
      undefined
    );
    const key = await coordinatorOperationKey(
      JSON.stringify([f.delivery.report.key, f.delivery.report.id])
    );
    assert.equal(
      await f.fixture
        .pi()
        .snapshot(SourceReportReceipts, f.source.native.id, key, context),
      undefined
    );
    f.eventFails(false);
    await f.receive(f.delivery, actor);
    await f.settleReports();
    assert.equal(f.fixture.eventSubmissions.length, 1);
  } finally {
    await f.fixture.close();
  }
});

test("reports atomically import provenance and event intent, and retries produce one coordinator answer", async () => {
  const f = await subject();
  try {
    const before = await f.messages();
    const calls = f.source.faux.state.callCount;
    f.importFails(true);
    await assert.rejects(f.receive(f.delivery, actor), /Import failed/u);
    const accepted = await f.fixture.work("a");
    assert.equal(accepted.reportId, f.delivery.report.id);
    assert.deepEqual(
      await readImportedContent(f.fixture.pi(), f.source.native.id),
      { sourceIds: ["source-B"], toolIds: ["tool-B"] }
    );
    f.importFails(false);
    f.notifyFails(true);
    await assert.rejects(
      f.receive(f.delivery, actor),
      /Notification scheduling/u
    );
    const completed = await f.fixture.work("a");
    assert.equal(completed.status.kind, "completed");
    f.notifyFails(false);
    const replay = await f.receive(f.delivery, actor);
    assert.equal(replay.accepted, true);
    assert.equal(f.notifications(), 2);
    await f.settleReports();
    assert.equal(f.source.faux.state.callCount, calls + 1);
    const after = await f.messages();
    assert.equal(after.length, before.length + 1);
    assert.deepEqual(
      await readImportedContent(f.fixture.pi(), f.source.native.id),
      { sourceIds: ["source-B"], toolIds: ["tool-B"] }
    );
    const changed = {
      ...f.delivery,
      report: {
        ...f.delivery.report,
        kind: "completed" as const,
        text: "Changed result.",
      },
    };
    await assert.rejects(
      f.receive(changed, actor),
      (error: unknown) =>
        error instanceof Conflict && error.code === "digest-mismatch"
    );
    const afterConflict = await f.messages();
    assert.equal(afterConflict.length, before.length + 1);
    const modelContext = await f.source.native.context(context);
    assert.match(JSON.stringify(modelContext), /Result based on B/u);
    const entries = await f.source.native.entries({}, 100, undefined, context);
    const point = entries.items.at(-1);
    assert.ok(point);
    const forked = await f.fixture.pi().commit(
      (tx) =>
        tx.forkConversation(f.source.native.id, point.id, {
          ownership: { kind: "ownerless" },
        }),
      context
    );
    assert.deepEqual(
      await f.fixture.pi().snapshot(ImportedContent, forked.id, context),
      { sourceIds: ["source-B"], toolIds: ["tool-B"] }
    );
    await f.fixture.invoke(
      "a",
      "start_team",
      { goal: "Use the previous result." },
      "second-human"
    );
    const following = await f.fixture.work("a");
    assert.ok(
      following.admission.contentDependencies.sourceIds.includes(
        id.source("source-B")
      )
    );
    assert.ok(
      following.admission.contentDependencies.toolIds.includes("tool-B")
    );
  } finally {
    await f.fixture.close();
  }
});

test("full reports stay in work storage while event input and recall remain bounded", async () => {
  const f = await subject();
  try {
    const delivery = Schema.decodeUnknownSync(TeamReportDeliverySchema)({
      ...f.delivery,
      report: {
        ...f.delivery.report,
        kind: "completed",
        text: "x".repeat(16_000),
      },
    });
    f.source.faux.setResponses([
      fauxAssistantMessage("The coordinator summarized the report."),
    ]);
    await f.receive(delivery, actor);
    await f.settleReports();
    const work = await f.fixture.work("a");
    assert.ok(work.terminalReport?.kind === "completed");
    assert.equal(work.terminalReport.text.length, 16_000);
    const events = await f.fixture.events().list(f.source.address, actor);
    const [receipt] = events.items;
    assert.ok(receipt);
    assert.equal(receipt.event.content.text.length, 2000);
    assert.equal(
      JSON.stringify(await f.source.native.context(context)).includes(
        "x".repeat(2100)
      ),
      false
    );
    const recalled = await f.fixture.invoke(
      "a",
      "recall_work",
      { workId: work.admission.key.workId },
      "recall-full-report"
    );
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        report: Schema.Struct({ text: Schema.String }),
        reportTruncated: Schema.Boolean,
      })
    )(JSON.parse(recalled.snapshot.tools.at(-1)?.output ?? "{}"));
    assert.equal(result.report.text.length, 4000);
    assert.equal(result.reportTruncated, true);
  } finally {
    await f.fixture.close();
  }
});

test("exact controls list work and ordinary input returns to the coordinator", async () => {
  const f = await subject();
  try {
    const calls = f.source.faux.state.callCount;
    assert.equal(await f.route("status-op", "status", actor), true);
    assert.equal(await f.route("update-op", "status please", actor), false);
    await f.fixture.waitDispatch();
    assert.deepEqual(
      f.fixture.delivered
        .filter((value) => value.kind === "input")
        .map((value) => (value.kind === "input" ? value.text : "")),
      []
    );
    await f.receive(f.delivery, actor);
    await f.settleReports();
    const before = await f.messages();
    assert.equal(await f.route("update-op", "status please", actor), false);
    assert.equal(await f.route("status-op", "status", actor), true);
    assert.deepEqual(await f.messages(), before);
    await assert.rejects(
      f.route("update-op", "changed", actor),
      (error: unknown) => error instanceof Conflict
    );
    assert.equal(await f.route("new-human", "Start fresh.", actor), false);
    assert.equal(f.source.faux.state.callCount, calls + 1);
  } finally {
    await f.fixture.close();
  }
});

test("exact controls list independent work IDs and bare stop selects no team", async () => {
  const f = await subject();
  try {
    const first = await f.fixture.work("a");
    await f.fixture.invoke(
      "a",
      "start_team",
      { goal: "Second independent goal." },
      "second-start"
    );
    const second = await f.fixture.work("a");
    assert.notEqual(first.admission.key.workId, second.admission.key.workId);
    assert.equal(await f.route("list-status", "status", actor), true);
    assert.equal(await f.route("ambiguous-stop", "stop", actor), true);
    const messages = await f.messages();
    const answer = messages.at(-1)?.text ?? "";
    assert.match(answer, /Choose a work ID/u);
    assert.ok(answer.includes(first.admission.key.workId));
    assert.ok(answer.includes(second.admission.key.workId));
    await f.fixture.waitDispatch();
    assert.equal(
      f.fixture.delivered.some((command) => command.kind === "cancel"),
      false
    );
    const ledger = await f.fixture.ledger();
    assert.ok(
      Object.values(ledger.works).every(
        (record) => record.status.kind === "accepted"
      )
    );
  } finally {
    await f.fixture.close();
  }
});

test("stop saves cancellation before late reports, and wrong sources or revoked access disclose nothing", async () => {
  const f = await subject();
  try {
    const wrong = {
      ...f.delivery,
      sourceEventAddress: {
        ...f.delivery.sourceEventAddress,
        sessionId: id.session("other"),
      },
    };
    await assert.rejects(
      f.receive(wrong, actor),
      (error: unknown) => error instanceof Denied
    );
    await f.source.coordinator.cancel({
      workId: f.delivery.report.key.workId,
      operationId: "stop-op",
    });
    const cancelled = await f.fixture.work("a");
    assert.equal(cancelled.status.kind, "cancelled");
    const ignored = await f.receive(f.delivery, actor);
    assert.equal(ignored.accepted, false);
    assert.equal(
      JSON.stringify(await f.messages()).includes("Result based on B."),
      false
    );
    assert.deepEqual(
      await readImportedContent(f.fixture.pi(), f.source.native.id),
      { sourceIds: [], toolIds: [] }
    );
    await f.fixture.waitDispatch();
    assert.equal(
      f.fixture.delivered.filter((value) => value.kind === "cancel").length,
      1
    );
    f.revoke();
    await assert.rejects(
      f.route("revoked-op", "status", actor),
      (error: unknown) => error instanceof Denied
    );
    await assert.rejects(
      f.receive(f.delivery, actor),
      (error: unknown) => error instanceof Denied
    );
  } finally {
    await f.fixture.close();
  }
});

test("report admission rejects format, owner, organization, source, and session changes before import", async () => {
  const f = await subject();
  try {
    const before = await f.messages();
    const { report, sourceEventAddress } = f.delivery;
    const invalid = [
      { report, sourceEventAddress, sourceSlackThread: f.source.thread },
      { ...f.delivery, sourceSlackThread: f.source.thread },
      {
        ...f.delivery,
        report: {
          ...report,
          key: { ...report.key, ownerPrincipalId: "other-owner" },
        },
      },
      {
        ...f.delivery,
        report: {
          ...report,
          key: { ...report.key, organizationId: "other-org" },
        },
      },
      {
        ...f.delivery,
        sourceEventAddress: {
          ...sourceEventAddress,
          conversationId: "other-source",
        },
      },
      {
        ...f.delivery,
        sourceEventAddress: { ...sourceEventAddress, agentId: "other-agent" },
      },
      {
        ...f.delivery,
        sourceEventAddress: {
          ...sourceEventAddress,
          sessionId: "other-session",
        },
      },
    ];
    await Promise.all(
      invalid.map((delivery) => assert.rejects(f.receive(delivery, actor)))
    );
    assert.deepEqual(await f.messages(), before);
    assert.deepEqual(
      await readImportedContent(f.fixture.pi(), f.source.native.id),
      { sourceIds: [], toolIds: [] }
    );
    const record = await f.fixture.work("a");
    assert.equal(record.reportId, null);
  } finally {
    await f.fixture.close();
  }
});

test("a retained legacy work requires its legacy report and exact saved thread before receipt replay", async () => {
  const f = await subject();
  try {
    const record = await f.fixture.work("a");
    assert.ok("version" in record.admission);
    const { version, ...fields } = record.admission;
    assert.equal(version, 2);
    const legacy = Schema.decodeUnknownSync(WorkAdmissionSchema, {
      onExcessProperty: "error",
    })({ ...fields, sourceSlackThread: f.source.thread });
    await f.fixture.pi().commit(async (tx) => {
      const document = await tx.doc(
        WorkDocuments,
        record.admission.key.workId,
        null
      );
      assert.ok(document.record);
      document.record.admission = legacy;
    }, context);
    await assert.rejects(
      f.receive(f.delivery, actor),
      (error: unknown) => error instanceof Denied
    );
    const delivery = Schema.decodeUnknownSync(TeamReportDeliverySchema, {
      onExcessProperty: "error",
    })({
      report: f.delivery.report,
      sourceEventAddress: legacy.sourceEventAddress,
      sourceSlackThread: f.source.thread,
    });
    assert.ok("sourceSlackThread" in delivery);
    const changed = {
      ...delivery,
      sourceSlackThread: {
        ...delivery.sourceSlackThread,
        rootTimestamp: "1800000099.000001",
      },
    };
    await assert.rejects(
      f.receive(changed, actor),
      (error: unknown) => error instanceof Denied
    );
    const first = await f.receive(delivery, actor);
    const replay = await f.receive(delivery, actor);
    await f.settleReports();
    assert.equal(first.accepted, true);
    assert.equal(replay.accepted, true);
    await assert.rejects(
      f.receive(changed, actor),
      (error: unknown) => error instanceof Denied
    );
    await assert.rejects(
      f.receive(f.delivery, actor),
      (error: unknown) => error instanceof Denied
    );
    const messages = await f.messages();
    assert.equal(
      messages.filter(
        (message) =>
          message.role === "assistant" &&
          message.text === "Coordinator result. Result based on B."
      ).length,
      1
    );
  } finally {
    await f.fixture.close();
  }
});

test("report intents and exact controls do not wait for a held foreground generation", async () => {
  const f = await subject();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    f.source.faux.setResponses([
      async () => {
        entered.resolve(true);
        await release.promise;
        return fauxAssistantMessage("Foreground finished.");
      },
    ]);
    const submission = await f.source.native.submit(
      {
        type: "input",
        content: "Concurrent request.",
        requestId: "held-foreground",
      },
      context
    );
    await entered.promise;
    await f.route("held-status", "status", actor, AbortSignal.timeout(1000));
    await f.route(
      "held-update",
      "Update while busy.",
      actor,
      AbortSignal.timeout(1000)
    );
    const receipt = await f.receive(
      f.delivery,
      actor,
      AbortSignal.timeout(1000)
    );
    assert.equal(receipt.accepted, true);
    f.revokeImports();
    const replay = await f.receive(
      f.delivery,
      actor,
      AbortSignal.timeout(1000)
    );
    assert.equal(replay.accepted, true);
    const messages = await f.messages();
    assert.doesNotMatch(JSON.stringify(messages), /Result based on B/u);
    release.resolve(true);
    await submission.wait(context);
    await f.settleReports();
    const history = await f.source.native.context(context);
    assert.match(JSON.stringify(history), /Result based on B/u);
    assert.match(JSON.stringify(history), /Foreground finished/u);
  } finally {
    release.resolve(true);
    await f.fixture.close();
  }
});

test("receiving dependency denial blocks the first report while cancelled metadata receipts stay available", async () => {
  const f = await subject();
  try {
    f.revokeImports();
    await assert.rejects(
      f.receive(f.delivery, actor),
      (error: unknown) => error instanceof Denied
    );
    const active = await f.fixture.work("a");
    assert.equal(active.reportId, null);
    assert.deepEqual(
      await readImportedContent(f.fixture.pi(), f.source.native.id),
      { sourceIds: [], toolIds: [] }
    );
    await f.source.coordinator.cancel({
      workId: f.delivery.report.key.workId,
      operationId: "cancel-before-report",
    });
    const ignored = await f.receive(f.delivery, actor);
    assert.equal(ignored.accepted, false);
    assert.equal(
      JSON.stringify(await f.messages()).includes("Result based on B."),
      false
    );
  } finally {
    await f.fixture.close();
  }
});

test("a native request from before profile enablement keeps its coordinator route", async () => {
  const f = await subject();
  try {
    f.source.faux.setResponses([
      fauxAssistantMessage("Original ordinary reply."),
    ]);
    const original = await f.source.native.submit(
      {
        type: "input",
        content: "Legacy ordinary input.",
        requestId: "legacy-operation",
      },
      context
    );
    await original.wait(context);
    const before = await f.messages();
    const calls = f.source.faux.state.callCount;
    assert.equal(
      await f.route("legacy-operation", "Legacy ordinary input.", actor),
      false
    );
    assert.deepEqual(await f.messages(), before);
    assert.equal(f.source.faux.state.callCount, calls);
    assert.equal(
      f.fixture.delivered.some((command) => command.kind === "input"),
      false
    );
  } finally {
    await f.fixture.close();
  }
});

test("targeted updates and cancellation commit while an earlier command is still pending", async () => {
  const f = await subject();
  try {
    f.fixture.hold();
    const before = await f.messages();
    const { workId } = f.delivery.report.key;
    for (const [operationId, text] of [
      ["pending-input-one", "Update one."],
      ["pending-input-two", "Update two."],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- Each command must save its own durable receipt before cancellation.
      await f.source.coordinator.admissions.commit(operationId, (tx) =>
        f.source.coordinator.commandIn(tx, workId, operationId, {
          kind: "input",
          text,
          contentDependencies: { sourceIds: [], toolIds: [] },
        })
      );
    }
    await f.source.coordinator.cancel({ workId, operationId: "pending-stop" });
    const record = await f.fixture.work("a");
    assert.equal(record.status.kind, "cancelled");
    assert.equal(Object.keys(record.pendingCommands).length, 3);
    const after = await f.messages();
    assert.deepEqual(after, before);
    f.fixture.release();
    await f.fixture.waitDispatch();
  } finally {
    f.fixture.release();
    await f.fixture.close();
  }
});
