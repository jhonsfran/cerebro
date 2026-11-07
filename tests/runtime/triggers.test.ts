/* oxlint-disable unicorn/no-await-expression-member -- Assertions read one field of freshly awaited durable state. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Schema } from "effect";

import {
  Conflict,
  Denied,
  Unavailable,
} from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import {
  TRIGGER_ENTRY_KIND,
  TriggerSchema,
  triggerId,
} from "../../packages/contracts/src/triggers.ts";
import type {
  Trigger,
  TriggerOrigin,
} from "../../packages/contracts/src/triggers.ts";
import {
  WorkIdSchema,
  WorkReportIdSchema,
} from "../../packages/contracts/src/work.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { chatPresentation } from "../../packages/runtime/src/pi-harness.ts";
import {
  Backlog,
  MAX_WAITING,
  Receipts,
  createTriggers,
} from "../../packages/runtime/src/triggers.ts";
import { actor, context, setup } from "./coordinator-fixture.ts";
import { waitFor } from "./helpers.ts";

type Fixture = Awaited<ReturnType<typeof setup>>;
const triggerFor = async (
  fixture: Fixture,
  name: string,
  origin?: TriggerOrigin,
  text = "A compact event."
): Promise<Trigger> => {
  const { address } = fixture.source(name);
  const source = origin ?? {
    kind: "web",
    operationId: id.operation("event-one"),
  };
  return Schema.decodeUnknownSync(TriggerSchema)({
    version: 2,
    id: await triggerId(address, source),
    address,
    ownerPrincipalId: actor.actor.id,
    origin: source,
    text,
    reference: null,
    reply: null,
    dependencies: { sourceIds: [], toolIds: [] },
  });
};
const backlog = async (fixture: Fixture, name: string) =>
  (
    await fixture
      .pi()
      .snapshot(Backlog, fixture.source(name).native.id, context)
  )?.ids ?? [];
const generations = (fixture: Fixture, name: string) =>
  fixture.pi().commit(async (tx) => {
    const page = await tx.scanTasks(
      { conversationId: fixture.source(name).native.id, kind: "pi.generation" },
      64
    );
    return page.items.length;
  }, context);
const holdRun = (fixture: Fixture, name: string, answers: string[]) => {
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  fixture.source(name).faux.setResponses([
    async () => {
      entered.resolve(true);
      await release.promise;
      return fauxAssistantMessage("Foreground finished.");
    },
    ...answers.map((answer) => fauxAssistantMessage(answer)),
  ]);
  return { entered, release };
};

for (const mode of ["all", "one-at-a-time"] as const) {
  test(`a burst admitted during a run is placed as ${mode === "all" ? "one batched turn" : "one turn per trigger"}`, async () => {
    const fixture = await setup(600_000, false, {}, mode);
    const { entered, release } = holdRun(fixture, "a", [
      "Batched answer.",
      "Second answer.",
      "Third answer.",
    ]);
    try {
      const source = fixture.source("a");
      const foreground = await source.native.submit(
        { type: "input", content: "Foreground.", requestId: "foreground" },
        context
      );
      await entered.promise;
      const triggers = await Promise.all(
        ["one", "two", "three"].map((name) =>
          triggerFor(fixture, "a", {
            kind: "web",
            operationId: id.operation(`burst-${name}`),
          })
        )
      );
      for (const trigger of triggers) {
        // oxlint-disable-next-line no-await-in-loop -- Arrival order is the backlog order under test.
        await fixture.triggers().admit(trigger, actor);
      }
      await waitFor(
        async () =>
          (await Promise.all(triggers.map((t) => fixture.placement(t.id)))).map(
            (placement) => placement.kind
          ),
        (kinds) => kinds.every((kind) => kind === "queued"),
        10_000,
        10
      );
      assert.deepEqual(await backlog(fixture, "a"), []);
      release.resolve(true);
      await foreground.wait(context);
      const placements = await Promise.all(
        triggers.map((trigger) => fixture.settled(trigger.id))
      );
      assert.ok(
        placements.every((placement) => placement.kind === "done"),
        JSON.stringify(placements)
      );
      const answers = new Set(
        placements.map((placement) =>
          placement.kind === "done" ? placement.answer : null
        )
      );
      const entries = await source.native.entries({}, 64, undefined, context);
      const kinds = entries.items
        .toSorted((left, right) => left.id - right.id)
        .map((entry) => entry.kind);
      const first = kinds.indexOf(TRIGGER_ENTRY_KIND);
      if (mode === "all") {
        assert.equal(answers.size, 1);
        assert.deepEqual(kinds.slice(first), [
          TRIGGER_ENTRY_KIND,
          TRIGGER_ENTRY_KIND,
          TRIGGER_ENTRY_KIND,
          "pi.assistant",
        ]);
        assert.equal(await generations(fixture, "a"), 2);
        assert.equal(source.faux.state.callCount, 2);
      } else {
        assert.equal(answers.size, 3);
        assert.deepEqual(kinds.slice(first), [
          TRIGGER_ENTRY_KIND,
          "pi.assistant",
          TRIGGER_ENTRY_KIND,
          "pi.assistant",
          TRIGGER_ENTRY_KIND,
          "pi.assistant",
        ]);
        assert.equal(await generations(fixture, "a"), 4);
        assert.equal(source.faux.state.callCount, 4);
      }
      assert.deepEqual(
        fixture.eventSubmissions,
        triggers.map((trigger) => trigger.id)
      );
    } finally {
      release.resolve(true);
      await fixture.close();
    }
  });
}

test("duplicate admissions keep one receipt, one submission, and one answer", async () => {
  const fixture = await setup();
  try {
    const trigger = await triggerFor(fixture, "a");
    const receipts = await Promise.all([
      fixture.triggers().admit(trigger, actor),
      fixture.triggers().admit(trigger, actor),
    ]);
    assert.deepEqual(
      receipts.map((receipt) => receipt.duplicates).toSorted(),
      [0, 1]
    );
    const placement = await fixture.settled(trigger.id);
    assert.ok(placement.kind === "done");
    assert.equal(fixture.eventSubmissions.length, 1);
    const exact = await fixture
      .pi()
      .commit(
        (tx) =>
          tx.submissionByRequest(fixture.source("a").native.id, trigger.id),
        context
      );
    assert.equal(exact?.id, placement.submissionId);
    assert.equal(exact?.status, "done");
    const input = await fixture
      .pi()
      .commit((tx) => tx.entry(placement.entry), context);
    assert.equal(input?.kind, TRIGGER_ENTRY_KIND);
    assert.deepEqual(input?.data, {
      id: trigger.id,
      channel: "web",
      operationId: "event-one",
    });
    const answer = await fixture
      .pi()
      .commit((tx) => tx.entry(placement.answer), context);
    assert.match(JSON.stringify(answer?.model), /Coordinator result/u);
    assert.deepEqual(await backlog(fixture, "a"), []);
    assert.equal((await fixture.receipt(trigger.id)).duplicates, 1);
  } finally {
    await fixture.close();
  }
});

test("a changed payload under the same ID conflicts and leaves the receipt and backlog unchanged", async () => {
  const fixture = await setup();
  try {
    const trigger = await triggerFor(fixture, "a");
    fixture.setGate("waiting");
    await fixture.triggers().admit(trigger, actor);
    const before = await fixture.receipt(trigger.id);
    await assert.rejects(
      fixture
        .pi()
        .commit(
          (tx) =>
            fixture.triggers().acceptIn(tx, { ...trigger, text: "Changed." }),
          context
        ),
      (error: unknown) => error instanceof Conflict
    );
    await assert.rejects(
      fixture.triggers().admit({ ...trigger, text: "Changed." }, actor),
      (error: unknown) => error instanceof Conflict
    );
    assert.deepEqual(await fixture.receipt(trigger.id), before);
    assert.deepEqual(await backlog(fixture, "a"), [trigger.id]);
    assert.equal(fixture.eventSubmissions.length, 0);
    assert.equal((await fixture.placement(trigger.id)).kind, "backlog");
  } finally {
    await fixture.close();
  }
});

test("a receipt accepted before the process stops is placed exactly once by restore", async () => {
  const fixture = await setup();
  try {
    const trigger = await triggerFor(fixture, "a");
    await fixture
      .pi()
      .commit((tx) => fixture.triggers().acceptIn(tx, trigger), context);
    assert.equal((await fixture.placement(trigger.id)).kind, "backlog");
    await fixture.reopen();
    const placement = await fixture.settled(trigger.id);
    assert.equal(placement.kind, "done");
    assert.deepEqual(fixture.eventSubmissions, [trigger.id]);
    assert.deepEqual(await backlog(fixture, "a"), []);
  } finally {
    await fixture.close();
  }
});

for (const point of ["before", "after"] as const) {
  test(`a crash ${point} the Pi submit still yields one placement after restore`, async () => {
    const fixture = await setup();
    try {
      const trigger = await triggerFor(fixture, "a");
      const entered = fixture.pauseEventSubmit(point);
      await fixture.triggers().admit(trigger, actor);
      await entered;
      assert.deepEqual(await backlog(fixture, "a"), [trigger.id]);
      fixture.clearEventPause();
      await fixture.reopen();
      const placement = await fixture.settled(trigger.id);
      assert.equal(placement.kind, "done");
      assert.deepEqual(
        fixture.eventSubmissions,
        point === "before" ? [trigger.id] : [trigger.id, trigger.id]
      );
      const submissions = await fixture.pi().commit(async (tx) => {
        const page = await tx.scanEntries(
          { conversationId: fixture.source("a").native.id },
          64
        );
        return page.items.filter((entry) => entry.kind === TRIGGER_ENTRY_KIND)
          .length;
      }, context);
      assert.equal(submissions, 1);
      assert.equal(fixture.source("a").faux.state.callCount, 1);
      assert.deepEqual(await backlog(fixture, "a"), []);
    } finally {
      await fixture.close();
    }
  });
}

test("delivery re-authorizes the owner and a denial withdraws the trigger without a model turn", async () => {
  const fixture = await setup();
  try {
    const trigger = {
      ...(await triggerFor(fixture, "a")),
      dependencies: { sourceIds: [id.source("private-source")], toolIds: [] },
    };
    await fixture
      .pi()
      .commit((tx) => fixture.triggers().acceptIn(tx, trigger), context);
    fixture.revokeContent("private-source");
    await fixture.reopen();
    const placement = await fixture.settled(trigger.id);
    assert.equal(placement.kind, "withdrawn");
    assert.equal(fixture.eventSubmissions.length, 0);
    assert.equal(fixture.source("a").faux.state.callCount, 0);
    assert.deepEqual(await backlog(fixture, "a"), []);
    assert.ok(await fixture.receipt(trigger.id));
  } finally {
    await fixture.close();
  }
});

test("a conversation accepts at most MAX_WAITING triggers across the backlog and Pi's inbox", async () => {
  const fixture = await setup();
  const { entered, release } = holdRun(
    fixture,
    "a",
    Array.from({ length: MAX_WAITING + 1 }, () => "Answered.")
  );
  try {
    const source = fixture.source("a");
    const foreground = await source.native.submit(
      { type: "input", content: "Hold.", requestId: "hold" },
      context
    );
    await entered.promise;
    const triggers = await Promise.all(
      Array.from({ length: MAX_WAITING + 1 }, (_, index) =>
        triggerFor(fixture, "a", {
          kind: "web",
          operationId: id.operation(`waiting-${index}`),
        })
      )
    );
    const half = Math.floor(MAX_WAITING / 2);
    for (const trigger of triggers.slice(0, half)) {
      // oxlint-disable-next-line no-await-in-loop -- Each placement consumes one slot of the same inbox.
      await fixture.triggers().admit(trigger, actor);
    }
    await waitFor(
      () => fixture.placement(triggers[half - 1]?.id ?? ""),
      (placement) => placement.kind === "queued",
      10_000,
      10
    );
    fixture.setGate("waiting");
    for (const trigger of triggers.slice(half, MAX_WAITING)) {
      // oxlint-disable-next-line no-await-in-loop -- Each receipt consumes one slot of the same backlog.
      await fixture.triggers().admit(trigger, actor);
    }
    const overflow = triggers.at(MAX_WAITING);
    assert.ok(overflow);
    await assert.rejects(
      fixture.triggers().admit(overflow, actor),
      (error: unknown) => error instanceof Unavailable
    );
    assert.equal(
      await fixture.pi().snapshot(Receipts, overflow.id, context),
      undefined
    );
    assert.equal((await backlog(fixture, "a")).length, MAX_WAITING - half);
    fixture.setGate("open");
    release.resolve(true);
    await foreground.wait(context);
    await fixture.triggers().drain(source.native.id);
    const placements = await Promise.all(
      triggers
        .slice(0, MAX_WAITING)
        .map((trigger) => fixture.settled(trigger.id))
    );
    assert.ok(placements.every((placement) => placement.kind === "done"));
    assert.equal(fixture.eventSubmissions.length, MAX_WAITING);
    assert.deepEqual(await backlog(fixture, "a"), []);
  } finally {
    release.resolve(true);
    await fixture.close();
  }
});

test("an internal report input cannot authorize start_team", async () => {
  const fixture = await setup();
  try {
    const trigger = await triggerFor(fixture, "a", {
      kind: "teamreport",
      key: {
        organizationId: actor.actor.organizationId,
        ownerPrincipalId: actor.actor.id,
        workId: Schema.decodeUnknownSync(WorkIdSchema)("report-work"),
      },
      reportId: Schema.decodeUnknownSync(WorkReportIdSchema)("report-one"),
      outcome: "completed",
    });
    fixture.source("a").faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("start_team", {
          goal: "Unauthorized report follow-on.",
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("The report was summarized."),
    ]);
    await fixture
      .pi()
      .commit((tx) => fixture.triggers().acceptIn(tx, trigger), context);
    await fixture.triggers().drain(fixture.source("a").native.id);
    await fixture.settled(trigger.id);
    const ledger = await fixture.ledger();
    assert.equal(ledger.documents, 0);
    const history = await fixture.source("a").native.context(context);
    assert.match(JSON.stringify(history), /current human request/u);
  } finally {
    await fixture.close();
  }
});

test("oversized trigger text is rejected without a receipt", async () => {
  const fixture = await setup();
  try {
    const trigger = await triggerFor(fixture, "a");
    await assert.rejects(
      fixture
        .pi()
        .commit(
          (tx) =>
            fixture
              .triggers()
              .acceptIn(tx, { ...trigger, text: "x".repeat(16_001) }),
          context
        )
    );
    assert.equal(
      await fixture.pi().snapshot(Receipts, trigger.id, context),
      undefined
    );
  } finally {
    await fixture.close();
  }
});

test("queued expiry saves one terminal notice that carries no reply destination and places once", async () => {
  const fixture = await setup(1000, true);
  try {
    await fixture.invoke(
      "a",
      "start_team",
      { goal: "First active goal." },
      "first-active"
    );
    await fixture.invoke(
      "b",
      "start_team",
      { goal: "Second active goal." },
      "second-active"
    );
    await fixture.invoke(
      "a",
      "start_team",
      { goal: "Queued goal." },
      "queued-goal"
    );
    const queued = await fixture.work("a");
    assert.equal(queued.status.kind, "queued");
    fixture.advance(1001);
    await fixture.source("a").coordinator.wake();
    const terminal = await fixture.work("a");
    assert.equal(terminal.status.kind, "failed");
    const page = await fixture
      .triggers()
      .list(fixture.source("a").address, actor);
    const notices = page.items.filter(
      (receipt) =>
        receipt.trigger.origin.kind === "teamnotice" &&
        receipt.trigger.origin.key.workId === queued.admission.key.workId
    );
    assert.equal(notices.length, 1);
    const [notice] = notices;
    assert.ok(notice);
    assert.equal(notice.trigger.reply, null);
    await fixture.reopen();
    await fixture.settled(notice.trigger.id);
    await fixture.source("a").coordinator.wake();
    await fixture.triggers().drain(fixture.source("a").native.id);
    assert.equal(
      fixture.eventSubmissions.filter(
        (requestId) => requestId === notice.trigger.id
      ).length,
      1
    );
  } finally {
    await fixture.close();
  }
});

test("permanent dispatch failure saves one sanitized notice with the failed status", async () => {
  const fixture = await setup(600_000, true);
  try {
    fixture.denyDispatch();
    await fixture.invoke(
      "a",
      "start_team",
      { goal: "Transport failure." },
      "failed-dispatch"
    );
    await fixture.waitDispatch();
    const work = await fixture.work("a");
    assert.equal(work.status.kind, "failed");
    const page = await fixture
      .triggers()
      .list(fixture.source("a").address, actor);
    const notices = page.items.filter(
      (receipt) => receipt.trigger.origin.kind === "teamnotice"
    );
    assert.equal(notices.length, 1);
    const [notice] = notices;
    assert.ok(notice);
    assert.equal(
      notice.trigger.text,
      "The team command could not be delivered."
    );
    await fixture.triggers().drain(fixture.source("a").native.id);
    await fixture.settled(notice.trigger.id);
    assert.equal(
      fixture.eventSubmissions.filter((value) => value === notice.trigger.id)
        .length,
      1
    );
    assert.equal(JSON.stringify(notice).includes("Private transport"), false);
  } finally {
    await fixture.close();
  }
});

test("a trigger revoked across restart is withdrawn without native execution", async () => {
  const fixture = await setup();
  try {
    const trigger = await triggerFor(fixture, "a");
    const entered = fixture.pauseEventSubmit("before");
    await fixture.triggers().admit(trigger, actor);
    await entered;
    fixture.revoke("a");
    fixture.clearEventPause();
    await fixture.reopen();
    const placement = await fixture.settled(trigger.id);
    assert.equal(placement.kind, "withdrawn");
    assert.equal(fixture.eventSubmissions.length, 0);
  } finally {
    await fixture.close();
  }
});

test("Stop withdraws the backlog and Pi's queued inputs", async () => {
  const fixture = await setup();
  const { entered, release } = holdRun(fixture, "a", []);
  try {
    const source = fixture.source("a");
    const foreground = await source.native.submit(
      { type: "input", content: "Hold.", requestId: "hold" },
      context
    );
    await entered.promise;
    const queued = await triggerFor(fixture, "a", {
      kind: "web",
      operationId: id.operation("queued-in-pi"),
    });
    await fixture.triggers().admit(queued, actor);
    await waitFor(
      () => fixture.placement(queued.id),
      (placement) => placement.kind === "queued",
      10_000,
      10
    );
    fixture.setGate("waiting");
    const held = await triggerFor(fixture, "a", {
      kind: "web",
      operationId: id.operation("held-in-backlog"),
    });
    await fixture.triggers().admit(held, actor);
    assert.equal((await fixture.placement(held.id)).kind, "backlog");
    assert.deepEqual(
      (await fixture.triggers().queuedWeb(source.native.id)).map(
        (input) => input.operationId
      ),
      ["held-in-backlog"]
    );
    await fixture.triggers().withdraw(source.native.id);
    const aborted = source.native.abort(context);
    release.resolve(true);
    await aborted;
    assert.equal((await fixture.placement(held.id)).kind, "withdrawn");
    assert.equal((await fixture.placement(queued.id)).kind, "unanswered");
    assert.deepEqual(await backlog(fixture, "a"), []);
    const outcome = await foreground.wait(context);
    assert.equal(outcome.status, "unanswered");
    fixture.setGate("open");
    assert.equal(await fixture.triggers().drain(source.native.id), "idle");
    assert.equal(source.faux.state.callCount, 1);
    const watch = await source.native.watch(context);
    try {
      assert.deepEqual(chatPresentation(watch.value).queuedInputs, []);
    } finally {
      await watch.stop();
    }
  } finally {
    release.resolve(true);
    await fixture.close();
  }
});

test("saved trigger reads require current read and content access without execution permission", async () => {
  const fixture = await setup();
  try {
    const trigger = {
      ...(await triggerFor(fixture, "a")),
      dependencies: { sourceIds: [id.source("private-source")], toolIds: [] },
    };
    await fixture.triggers().admit(trigger, actor);
    await fixture.settled(trigger.id);
    const receipt = await fixture.receipt(trigger.id);
    const source = fixture.source("a");
    let readAllowed = true;
    let contentAllowed = true;
    const operations: string[] = [];
    const scope = {
      native: source.native,
      ownerPrincipalId: actor.actor.id,
      requireCurrent: () => {},
      commit: source.coordinator.admissions.commit,
      gate: () => Promise.resolve("open" as const),
      readAccess: () =>
        readAllowed
          ? Promise.resolve()
          : Promise.reject(
              new Denied({ code: "revoked", reason: "Execution is denied." })
            ),
      authorize: async (value: Trigger, _caller: unknown, action: string) => {
        operations.push(action);
        if (action !== "read" || !readAllowed) {
          throw new Denied({ code: "revoked", reason: "Execution is denied." });
        }
        await Effect.runPromise(
          contentAllowed || value.dependencies.sourceIds.length === 0
            ? Effect.void
            : Effect.fail(
                new Denied({ code: "revoked", reason: "Content is denied." })
              )
        );
      },
    };
    const triggers = createTriggers({
      pi: fixture.pi(),
      targetIn: () => Promise.resolve({ nativeId: source.native.id }),
      resolve: () => Promise.resolve(scope),
      scan: () => Promise.resolve({ keys: [trigger.id] }),
      waitUntil: () =>
        assert.fail("Reading triggers must not start native work."),
    });
    assert.deepEqual(await triggers.read(trigger.id, actor), receipt);
    const page = await triggers.list(source.address, actor);
    assert.deepEqual(page.items, [receipt]);
    assert.deepEqual(operations, ["read", "read"]);
    await assert.rejects(
      triggers.admit(trigger, actor),
      (error: unknown) => error instanceof Denied
    );
    contentAllowed = false;
    await assert.rejects(
      triggers.read(trigger.id, actor),
      (error: unknown) => error instanceof Denied
    );
    await assert.rejects(
      triggers.list(source.address, actor),
      (error: unknown) => error instanceof Denied
    );
    contentAllowed = true;
    readAllowed = false;
    await assert.rejects(
      triggers.read(trigger.id, actor),
      (error: unknown) => error instanceof Denied
    );
    await assert.rejects(
      triggers.list(source.address, actor),
      (error: unknown) => error instanceof Denied
    );
    assert.equal(fixture.eventSubmissions.length, 1);
  } finally {
    await fixture.close();
  }
});
