/* oxlint-disable no-await-in-loop -- Each assertion follows a committed source change. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { Denied, InvalidInput } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { InspectionQuery } from "../../packages/contracts/src/inspection.ts";
import { digestToolArguments } from "../../packages/contracts/src/tools.ts";
import {
  TriggerAdmissionSchema,
  TriggerOriginSchema,
  TriggerSchema,
  triggerId,
} from "../../packages/contracts/src/triggers.ts";
import { WorkIdSchema } from "../../packages/contracts/src/work.ts";
import { defineDocFamily } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import {
  Bindings,
  ProfileChanged,
} from "../../packages/runtime/src/conversation-bindings.ts";
import {
  WorkDocuments,
  RecentTerminalWork,
} from "../../packages/runtime/src/coordinator-ledger.ts";
import { ImportedContent } from "../../packages/runtime/src/imported-content.ts";
import { inspectionCursor } from "../../packages/runtime/src/inspection-page.ts";
import { Replies } from "../../packages/runtime/src/replies.ts";
import { Receipts } from "../../packages/runtime/src/triggers.ts";
import { context } from "./coordinator-fixture.ts";
import { inspectionFixture } from "./inspection-fixture.ts";

test("old event formats in the identity do not prevent inspection of current conversation events", async () => {
  const subject = await inspectionFixture();
  const { fixture } = subject;
  try {
    const retired = defineDocFamily({
      kind: Receipts.definition.kind,
      scope: "session",
      family: true,
      version: 2,
      initial: (_seed: null) => ({
        receipt: {
          nativeId: fixture.source("b").native.id,
          input: { text: "retained-private-event" },
        },
      }),
    });
    await fixture.pi().commit(async (tx) => {
      for (let index = 0; index < 32; index += 1) {
        await tx.doc(retired, `old-event-${index}`, null);
      }
    }, context);
    await fixture.invoke("a", "list_work", {}, "current-event");
    const first = await subject.read({ kind: "events" });
    assert.ok(first.kind === "events" && first.next);
    assert.deepEqual(first.events, []);
    const frame = await subject.read({ kind: "events", cursor: first.next });
    assert.ok(frame.kind === "events");
    assert.equal(frame.events.length, 1);
    assert.equal(frame.events[0]?.channel, "web");
    assert.equal(
      JSON.stringify(frame).includes("retained-private-event"),
      false
    );
    assert.ok(await fixture.pi().snapshot(retired, "old-event-0", context));
  } finally {
    await subject.close();
  }
});

test("Inspector reports newer event formats instead of silently omitting them", async () => {
  const subject = await inspectionFixture();
  try {
    const future = defineDocFamily({
      kind: Receipts.definition.kind,
      scope: "session",
      family: true,
      version: 5,
      initial: (_seed: null) => ({ receipt: null }),
    });
    await subject.fixture
      .pi()
      .commit((tx) => tx.doc(future, "future-event", null), context);
    await assert.rejects(
      subject.read({ kind: "events" }),
      /newer version 5 than 4/u
    );
  } finally {
    await subject.close();
  }
});

test("Inspector keeps owned recent work, queued work, and held reservations separate without opening Teams", async () => {
  const subject = await inspectionFixture();
  const { fixture, source } = subject;
  try {
    await fixture.invoke("a", "start_team", { goal: "First result." }, "first");
    await fixture.waitDispatch();
    const first = await fixture.work("a");
    await fixture.report("a", "first-report");
    await fixture.invoke(
      "a",
      "start_team",
      { goal: "Second result." },
      "second"
    );
    await fixture.invoke("a", "start_team", { goal: "Third result." }, "third");
    await fixture.waitDispatch();
    await fixture.invoke(
      "a",
      "start_team",
      { goal: "Queued result." },
      "fourth"
    );
    const ledger = await fixture.ledger();
    const held = Object.values(ledger.works).find(
      (record) => record.status.kind === "accepted"
    );
    const queued = Object.values(ledger.works).find(
      (record) => record.status.kind === "queued"
    );
    assert.ok(held && queued);
    await fixture.pi().commit(async (tx) => {
      const saved = await tx.doc(
        WorkDocuments,
        held.admission.key.workId,
        null
      );
      assert.ok(saved.record);
      saved.record.status = {
        kind: "failed",
        reason: "private-provider-error-marker",
      };
    }, context);
    const calls = source.faux.state.callCount;
    const frame = await subject.read({ kind: "overview" });
    assert.equal(frame.kind, "overview");
    if (frame.kind !== "overview") {
      assert.fail();
    }
    assert.deepEqual(frame.profile, { agentVersion: 7 });
    assert.equal(frame.refresh, true);
    assert.equal(
      frame.work.find((item) => item.workId === first.admission.key.workId)
        ?.result?.content.text,
      "Team result."
    );
    assert.deepEqual(
      frame.work.find((item) => item.workId === held.admission.key.workId)
        ?.status,
      "failed"
    );
    assert.equal(
      frame.work.find((item) => item.workId === held.admission.key.workId)
        ?.reservationHeld,
      true
    );
    const selected = await subject.read({
      kind: "team",
      workId: queued.admission.key.workId,
    });
    assert.ok(selected.kind === "team");
    assert.deepEqual(selected.team, { kind: "not-started" });
    assert.equal(subject.calls.length, 0);
    const pending = await subject.read({
      kind: "team",
      workId: held.admission.key.workId,
    });
    assert.ok(pending.kind === "team");
    assert.deepEqual(pending.team, {
      kind: "unavailable",
      reason: "execution-unavailable",
    });
    assert.equal(pending.work.reservationHeld, true);
    assert.equal(source.faux.state.callCount, calls);
    assert.equal(
      JSON.stringify(frame).includes("private-provider-error-marker"),
      false
    );
    const recent = await fixture
      .pi()
      .snapshot(RecentTerminalWork, source.address.sessionId, context);
    assert.deepEqual(recent?.ids, [first.admission.key.workId]);
  } finally {
    await subject.close();
  }
});

test("Inspector rechecks complete raw and canonical content after private projection", async () => {
  const subject = await inspectionFixture();
  const { fixture, source } = subject;
  try {
    await fixture.invoke(
      "a",
      "start_team",
      { goal: "Read private work." },
      "start"
    );
    await fixture.waitDispatch();
    const work = await fixture.work("a");
    await fixture.pi().commit(async (tx) => {
      subject.raw.importDependencies({
        sourceIds: Array.from({ length: 513 }, (_, index) =>
          id.source(`raw-${index}`)
        ),
        toolIds: ["raw-tool"],
      });
      const canonical = await tx.doc(ImportedContent, source.native.id);
      canonical.sourceIds = [id.source("canonical-only")];
    }, context);
    subject.setProject(async () => {
      await fixture.pi().commit(async (tx) => {
        const canonical = await tx.doc(ImportedContent, source.native.id);
        canonical.sourceIds.push(id.source("newly-revoked"));
      }, context);
      subject.denied.add("newly-revoked");
      return {
        kind: "team",
        workId: work.admission.key.workId,
        team: { kind: "unavailable", reason: "execution-unavailable" },
      };
    });
    await assert.rejects(
      subject.read({ kind: "team", workId: work.admission.key.workId }),
      Denied
    );
    const checked = subject.checks.at(-1);
    assert.ok(checked);
    assert.equal(checked.dependencies.sourceIds.length, 516);
    assert.equal(
      checked.dependencies.sourceIds.includes(id.source("raw-512")),
      true
    );
    assert.equal(
      checked.dependencies.sourceIds.includes(id.source("canonical-only")),
      true
    );
    assert.equal(
      checked.dependencies.sourceIds.includes(id.source("newly-revoked")),
      true
    );
    assert.equal(checked.dependencies.toolIds.includes("raw-tool"), true);
    assert.equal(subject.calls.length, 1);
  } finally {
    await subject.close();
  }
});

test("Inspector rejects foreign work, changed admissions, and profile adoption before emission", async () => {
  const subject = await inspectionFixture();
  const { fixture, source } = subject;
  try {
    await fixture.invoke("a", "start_team", { goal: "Owned." }, "owned");
    await fixture.invoke("b", "start_team", { goal: "Foreign." }, "foreign");
    await fixture.waitDispatch();
    const owned = await fixture.work("a");
    const foreign = await fixture.work("b");
    await assert.rejects(
      subject.read({ kind: "team", workId: foreign.admission.key.workId }),
      Denied
    );
    assert.equal(subject.calls.length, 0);
    subject.setProject(async () => {
      await fixture.pi().commit(async (tx) => {
        const saved = await tx.doc(
          WorkDocuments,
          owned.admission.key.workId,
          null
        );
        assert.ok(saved.record);
        saved.record.admission = {
          ...saved.record.admission,
          goal: "Changed immutable admission.",
        };
      }, context);
      return {
        kind: "team",
        workId: owned.admission.key.workId,
        team: { kind: "unavailable", reason: "execution-unavailable" },
      };
    });
    await assert.rejects(
      subject.read({ kind: "team", workId: owned.admission.key.workId }),
      Denied
    );
    subject.onCheck(async () => {
      await fixture.pi().commit(async (tx) => {
        const bindings = await tx.doc(Bindings);
        const saved = bindings.conversations[source.address.sessionId];
        assert.ok(saved);
        saved.agentVersion = 8;
      }, context);
    });
    await assert.rejects(subject.read({ kind: "overview" }), ProfileChanged);
  } finally {
    await subject.close();
  }
});

test("Inspector history uses scoped native cursors and excludes foreign source work", async () => {
  const subject = await inspectionFixture();
  const { fixture, source } = subject;
  try {
    await fixture.invoke("a", "start_team", { goal: "History." }, "history");
    await fixture.waitDispatch();
    const template = await fixture.work("a");
    await fixture.pi().commit(async (tx) => {
      for (let index = 0; index < 36; index += 1) {
        const workId = Schema.decodeUnknownSync(WorkIdSchema)(
          `history-${String(index).padStart(2, "0")}`
        );
        const document = await tx.doc(WorkDocuments, workId, null);
        document.record = {
          ...template,
          admission: {
            ...template.admission,
            key: { ...template.admission.key, workId },
          },
        };
      }
    }, context);
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await subject.read({
        kind: "history",
        ...(cursor ? { cursor } : {}),
      });
      assert.equal(page.kind, "history");
      if (page.kind !== "history") {
        assert.fail();
      }
      for (const work of page.work) {
        assert.equal(seen.has(work.workId), false);
        seen.add(work.workId);
      }
      cursor = page.next ?? undefined;
    } while (cursor);
    assert.equal(seen.size, 37);
    const first = await subject.read({ kind: "history" });
    assert.ok(first.kind === "history" && first.next);
    assert.throws(
      () =>
        inspectionCursor(
          { ...source.address, sessionId: id.session("foreign-session") },
          { kind: "history", cursor: first.next }
        ),
      InvalidInput
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(InspectionQuery, { onExcessProperty: "error" })({
        kind: "team",
        workId: template.admission.key.workId,
        cell: "foreign-cell",
      })
    );
  } finally {
    await subject.close();
  }
});

test("Inspector projects retained event routes and reply retries without stored content or delivery errors", async () => {
  const subject = await inspectionFixture();
  const { fixture, source } = subject;
  try {
    const origin = Schema.decodeUnknownSync(TriggerOriginSchema)({
      kind: "slack",
      eventId: "inspection-slack",
      thread: source.thread,
    });
    const destination = {
      kind: "slack" as const,
      authority: {
        appId: "app-A",
        eventId: "inspection-slack",
        userId: "slack-A",
        thread: source.thread,
      },
      ownerPrincipalId: source.ownerPrincipalId,
      source: source.address,
    };
    const trigger = Schema.decodeUnknownSync(TriggerSchema)({
      version: 2,
      id: await triggerId(source.address, origin),
      address: source.address,
      ownerPrincipalId: source.ownerPrincipalId,
      origin,
      text: "hidden-event-content-marker",
      reference: null,
      reply: destination,
      dependencies: { sourceIds: [], toolIds: ["event-tool"] },
    });
    const input = Schema.decodeUnknownSync(TriggerAdmissionSchema)({
      version: 3,
      kind: "trigger-admission",
      trigger,
      routing: { kind: "automatic" },
    });
    const digest = await digestToolArguments(input);
    await fixture.pi().commit(async (tx) => {
      const saved = await tx.doc(Receipts, trigger.id, null);
      saved.receipt = {
        trigger,
        digest,
        nativeId: source.native.id,
        duplicates: 3,
        route: { kind: "inbox", skipped: [] },
      };
      const reply = await tx.doc(Replies, trigger.id, null);
      reply.record = {
        triggerId: trigger.id,
        nativeId: source.native.id,
        destination,
        dependencies: { sourceIds: [], toolIds: ["reply-tool"] },
        key: "hidden-delivery-key",
        text: "hidden-reply-text-marker",
        delivery: {
          state: "retry",
          text: "hidden-delivery-text-marker",
          retryAt: 1234,
        },
        taskId: null,
        attempts: 2,
        until: 5678,
      };
    }, context);
    const frame = await subject.read({ kind: "events" });
    assert.ok(frame.kind === "events");
    assert.deepEqual(frame.events, [
      {
        id: trigger.id,
        channel: "slack",
        actor: "human",
        route: "inbox",
        duplicates: 3,
        placement: "withdrawn",
        workIds: [],
        returns: [],
        reply: {
          taskId: null,
          state: "retry",
          attempts: 2,
          deadlineAt: 5678,
          retryAt: 1234,
          timestamp: null,
        },
      },
    ]);
    assert.equal(JSON.stringify(frame).includes("hidden-"), false);
    assert.equal(
      subject.checks.at(-1)?.dependencies.toolIds.includes("event-tool"),
      true
    );
    assert.equal(
      subject.checks.at(-1)?.dependencies.toolIds.includes("reply-tool"),
      true
    );
    subject.denied.add("reply-tool");
    await assert.rejects(subject.read({ kind: "events" }), Denied);
  } finally {
    await subject.close();
  }
});
