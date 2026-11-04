import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Schema } from "effect";

import { Conflict, Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { TeamReportDeliverySchema } from "../../packages/contracts/src/work.ts";
import { fauxAssistantMessage } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { createCoordinatorReport } from "../../packages/runtime/src/coordinator-report.ts";
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
  });
  const route = createCoordinatorSource(ports);
  const record = await fixture.work("a");
  const delivery = Schema.decodeUnknownSync(TeamReportDeliverySchema)({
    sourceEventAddress: record.admission.sourceEventAddress,
    sourceSlackThread: record.admission.sourceSlackThread,
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
  return {
    fixture,
    source,
    delivery,
    receive,
    route,
    messages,
    notifications: () => notifications,
    importFails: (value: boolean) => {
      importFails = value;
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

test("reports atomically import native provenance and passive history, and retries repair notification scheduling without another model run", async () => {
  const f = await subject();
  try {
    const before = await f.messages();
    const calls = f.source.faux.state.callCount;
    f.importFails(true);
    await assert.rejects(f.receive(f.delivery, actor), /Import failed/u);
    const failed = await f.fixture.work("a");
    assert.equal(failed.reportId, null);
    assert.deepEqual(
      await readImportedContent(f.fixture.pi(), f.source.native.id),
      { sourceIds: [], toolIds: [] }
    );
    assert.deepEqual(await f.messages(), before);
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
    assert.equal(f.source.faux.state.callCount, calls);
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

test("exact controls precede direct updates and saved routes survive terminal work", async () => {
  const f = await subject();
  try {
    const calls = f.source.faux.state.callCount;
    assert.equal(await f.route("status-op", "status", actor), true);
    assert.equal(await f.route("update-op", "status please", actor), true);
    await f.fixture.waitDispatch();
    assert.deepEqual(
      f.fixture.delivered
        .filter((value) => value.kind === "input")
        .map((value) => (value.kind === "input" ? value.text : "")),
      ["status please"]
    );
    await f.receive(f.delivery, actor);
    const before = await f.messages();
    assert.equal(await f.route("update-op", "status please", actor), true);
    assert.equal(await f.route("status-op", "status", actor), true);
    assert.deepEqual(await f.messages(), before);
    await assert.rejects(
      f.route("update-op", "changed", actor),
      (error: unknown) => error instanceof Conflict
    );
    assert.equal(await f.route("new-human", "Start fresh.", actor), false);
    assert.equal(f.source.faux.state.callCount, calls);
  } finally {
    await f.fixture.close();
  }
});

test("stop saves cancellation before late reports, and wrong sources or revoked access disclose nothing", async () => {
  const f = await subject();
  try {
    const wrong = {
      ...f.delivery,
      sourceSlackThread: {
        ...f.delivery.sourceSlackThread,
        channelId: "D-other",
      },
    };
    await assert.rejects(
      f.receive(wrong, actor),
      (error: unknown) => error instanceof Denied
    );
    await f.route("stop-op", "stop", actor);
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

test("passive reports and exact controls do not wait for a held foreground generation", async () => {
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
    assert.match(JSON.stringify(messages), /Result based on B/u);
    release.resolve(true);
    await submission.wait(context);
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
    await f.route("cancel-before-report", "stop", actor);
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

test("passive updates and stop commit while an earlier command is still pending", async () => {
  const f = await subject();
  try {
    f.fixture.hold();
    const before = await f.messages();
    await f.route("pending-input-one", "Update one.", actor);
    await f.route("pending-input-two", "Update two.", actor);
    await f.route("pending-stop", "stop", actor);
    const record = await f.fixture.work("a");
    assert.equal(record.status.kind, "cancelled");
    assert.equal(Object.keys(record.pendingCommands).length, 3);
    const after = await f.messages();
    assert.equal(after.length, before.length + 4);
    assert.equal(
      after.filter(
        (message) => message.role === "user" && message.text === "Update one."
      ).length,
      1
    );
    f.fixture.release();
    await f.fixture.waitDispatch();
  } finally {
    f.fixture.release();
    await f.fixture.close();
  }
});
