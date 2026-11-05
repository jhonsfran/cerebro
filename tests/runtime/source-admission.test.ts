import assert from "node:assert/strict";
import { test } from "node:test";

import { botEventId } from "../../packages/contracts/src/bot-events.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { defineTask } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { BotEventReceipts } from "../../packages/runtime/src/coordinator-event-state.ts";
import {
  SourceOperations,
  coordinatorOperationKey,
} from "../../packages/runtime/src/coordinator-ledger.ts";
import { ReminderOrigins } from "../../packages/runtime/src/saved-timer-state.ts";
import {
  SourceAdmission,
  createSourceAdmission,
} from "../../packages/runtime/src/source-admission.ts";
import { context } from "./coordinator-fixture.ts";
import { actor, setupWeb } from "./coordinator-web-fixture.ts";
import { waitFor } from "./helpers.ts";

const primary = (subject: Awaited<ReturnType<typeof setupWeb>>) => ({
  ...subject.source.address,
  conversationId: id.conversation("primary-public"),
  sessionId: id.session("primary-session"),
});
const cutover = (
  subject: Awaited<ReturnType<typeof setupWeb>>,
  busy = () => false,
  jobs = subject.fixture.lifecycleJobs
) =>
  createSourceAdmission({
    pi: subject.fixture.pi(),
    nativeId: subject.source.native.id,
    address: subject.source.address,
    primary: primary(subject),
    busy,
    jobs,
    persist: () => Promise.resolve(),
  });
const until = async (check: () => Promise<boolean>): Promise<void> => {
  await waitFor(check, Boolean);
};

test("a denied old send digest cannot reopen a historical source, while saved controls and history stay available", async () => {
  const subject = await setupWeb(true, "slack");
  try {
    subject.setModelEnabled(false);
    const denied = await subject.send(
      "denied-before-submit",
      "A request rejected before native admission."
    );
    assert.equal(denied.status, 403);
    const key = await coordinatorOperationKey("denied-before-submit");
    const marker = await subject.fixture
      .pi()
      .snapshot(SourceOperations, subject.source.native.id, key, context);
    assert.ok(marker?.digest);
    assert.equal(marker.route?.kind, "coordinator");
    assert.equal(
      await subject.fixture
        .pi()
        .commit(
          (tx) =>
            tx.submissionByRequest(
              subject.source.native.id,
              "denied-before-submit"
            ),
          context
        ),
      undefined
    );
    subject.setModelEnabled(true);
    const source = cutover(subject);
    await source.restore();
    const savedResult1 = await source.read();
    assert.equal(savedResult1.kind, "paused");
    const savedResult2 = await subject.send(
      "denied-before-submit",
      "A request rejected before native admission."
    );
    assert.equal(savedResult2.status, 403);
    const savedResult3 = await subject.send("fresh", "A fresh request.");
    assert.equal(savedResult3.status, 403);
    const savedResult4 = await subject.send("saved-status", "status");
    assert.equal(savedResult4.status, 200);
    const schedule = await subject.scope.handle(
      new Request("https://session.internal/control", {
        method: "POST",
        body: JSON.stringify({
          command: {
            kind: "schedule",
            operationId: "fresh-schedule",
            instruction: "Do not admit this.",
            runAt: Date.now() + 10_000,
          },
        }),
      }),
      actor
    );
    assert.equal(schedule.status, 403);
    await source.advance();
    const savedResult5 = await source.read();
    assert.equal(savedResult5.kind, "archived");
    const snapshot = await subject.scope.read(actor);
    assert.deepEqual(snapshot.admission, {
      kind: "closed",
      phase: "archived",
      primary: primary(subject),
    });
    assert.ok(
      snapshot.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.text.includes("no active or queued")
      )
    );
    assert.equal(subject.source.faux.state.callCount, 0);
    assert.equal(
      subject.fixture.lifecycleJobs
        .list()
        .filter((job) => job.fn === "cerebro-reminder").length,
      0
    );
  } finally {
    await subject.close();
  }
});

test("an accepted held web receipt still claims after pause and then permits archive", async () => {
  const subject = await setupWeb();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.source.faux.setResponses([
      fauxAssistantMessage("The accepted old request completed."),
    ]);
    subject.setDeliveryAuthorization(async () => {
      entered.resolve(true);
      await release.promise;
    });
    const text = "An accepted request before cutover.";
    const savedResult6 = await subject.send("held-before-pause", text);
    assert.equal(savedResult6.status, 200);
    await entered.promise;
    const source = cutover(subject);
    await source.restore();
    const waiting = await source.advance();
    assert.ok(waiting && waiting.rescheduleAt);
    const savedResult7 = await source.read();
    assert.equal(savedResult7.kind, "paused");
    const savedResult8 = await subject.send("new-after-pause", "A new topic.");
    assert.equal(savedResult8.status, 403);
    release.resolve(true);
    const eventId = await botEventId(subject.source.address, {
      kind: "web",
      operationId: id.operation("held-before-pause"),
    });
    await until(async () => {
      const saved = await subject.fixture
        .pi()
        .snapshot(BotEventReceipts, eventId, context);
      return (
        saved?.receipt?.delivery.kind === "coordinator" &&
        saved.receipt.delivery.admission.kind === "settled"
      );
    });
    await source.advance();
    const savedResult9 = await source.read();
    assert.equal(savedResult9.kind, "archived");
    const savedResult10 = await subject.send("held-before-pause", text);
    assert.equal(savedResult10.status, 200);
    const snapshot = await subject.scope.read(actor);
    assert.equal(
      snapshot.messages.filter((message) => message.text === text).length,
      1
    );
    assert.equal(subject.source.faux.state.callCount, 1);
  } finally {
    release.resolve(true);
    await subject.close();
  }
});

test("queued and placed native input remain exact accepted replay after ordinary admission closes", async () => {
  const subject = await setupWeb();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.source.faux.setResponses([
      async () => {
        entered.resolve(true);
        await release.promise;
        return fauxAssistantMessage("First answer.");
      },
      fauxAssistantMessage("Queued answer."),
    ]);
    const first = await subject.source.native.submit(
      { type: "input", requestId: "running-old", content: "Running input." },
      context
    );
    await entered.promise;
    const queued = await subject.source.native.submit(
      {
        type: "input",
        requestId: "queued-old",
        content: "Original queued input.",
      },
      context
    );
    const savedResult11 = await queued.status(context);
    assert.equal(savedResult11.status, "queued");
    const source = cutover(subject);
    await source.restore();
    const savedResult12 = await subject.send(
      "queued-old",
      "Original queued input."
    );
    assert.equal(savedResult12.status, 200);
    const savedResult13 = await subject.send(
      "queued-old",
      "Changed queued input."
    );
    assert.equal(savedResult13.status, 409);
    release.resolve(true);
    await first.wait(context);
    await queued.wait(context);
    await source.advance();
    const savedResult14 = await source.read();
    assert.equal(savedResult14.kind, "archived");
    const savedResult15 = await subject.send(
      "queued-old",
      "Original queued input."
    );
    assert.equal(savedResult15.status, 200);
    const savedResult16 = await subject.send(
      "queued-old",
      "Changed queued input."
    );
    assert.equal(savedResult16.status, 409);
    assert.equal(subject.source.faux.state.callCount, 2);
  } finally {
    release.resolve(true);
    await subject.close();
  }
});

test("an aborted unplaced native ID without its original payload cannot authorize archived input", async () => {
  const subject = await setupWeb();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.source.faux.setResponses([
      async () => {
        entered.resolve(true);
        await release.promise;
        return fauxAssistantMessage("First answer.");
      },
    ]);
    const first = await subject.source.native.submit(
      { type: "input", requestId: "opaque-running", content: "Running input." },
      context
    );
    await entered.promise;
    const queued = await subject.source.native.submit(
      {
        type: "input",
        requestId: "opaque-aborted",
        content: "Original removed input.",
      },
      context
    );
    await queued.abort(context);
    const stopped = await queued.status(context);
    assert.equal(stopped.status, "unanswered");
    assert.equal(stopped.entry, undefined);
    const source = cutover(subject);
    await source.restore();
    const savedResult17 = await subject.send(
      "opaque-aborted",
      "Changed input."
    );
    assert.equal(savedResult17.status, 409);
    const savedResult18 = await subject.send(
      "opaque-aborted",
      "Original removed input."
    );
    assert.equal(savedResult18.status, 409);
    release.resolve(true);
    await first.wait(context);
    assert.equal(subject.source.faux.state.callCount, 1);
  } finally {
    release.resolve(true);
    await subject.close();
  }
});

test("a prearmed cutover wake repairs a crash before pause without a chat reader", async () => {
  const subject = await setupWeb();
  try {
    const jobs = {
      ...subject.fixture.lifecycleJobs,
      push: async (
        input: Parameters<typeof subject.fixture.lifecycleJobs.push>[0]
      ) => {
        await subject.fixture.lifecycleJobs.push(input);
        throw new Error("Process stopped after durable wake.");
      },
    };
    await assert.rejects(
      cutover(subject, () => false, jobs).restore(),
      /durable wake/u
    );
    assert.ok(
      subject.fixture.lifecycleJobs.get(
        `cerebro-source-cutover:${subject.source.address.sessionId}`
      )
    );
    const before = await subject.fixture
      .pi()
      .snapshot(SourceAdmission, subject.source.native.id, context);
    assert.ok(!before || before.state.kind === "open");
    const recovered = cutover(subject);
    await recovered.advance();
    const savedResult19 = await recovered.read();
    assert.equal(savedResult19.kind, "archived");
    assert.equal(subject.source.faux.state.callCount, 0);
  } finally {
    await subject.close();
  }
});

test("trusted saved Slack input can finish after archive while ordinary input and current model denial remain closed", async () => {
  const subject = await setupWeb(true, "slack");
  try {
    const source = cutover(subject);
    await source.restore();
    await source.advance();
    const savedResult20 = await subject.send(
      "fresh-slack",
      "A fresh legacy message."
    );
    assert.equal(savedResult20.status, 403);
    subject.setModelEnabled(false);
    await assert.rejects(
      subject.scope.acceptLegacyInput(
        {
          operationId: "slack:saved",
          text: "The exact saved legacy decision.",
        },
        actor
      )
    );
    assert.equal(subject.source.faux.state.callCount, 0);
    subject.setModelEnabled(true);
    subject.source.faux.setResponses([
      fauxAssistantMessage("The accepted old Slack input completed."),
    ]);
    await subject.scope.acceptLegacyInput(
      { operationId: "slack:saved", text: "The exact saved legacy decision." },
      actor
    );
    await subject.source.native.waitForIdle(context);
    assert.equal(subject.source.faux.state.callCount, 1);
    const savedResult21 = await source.read();
    assert.equal(savedResult21.kind, "archived");
    await subject.scope.acceptLegacyInput(
      { operationId: "slack:saved", text: "The exact saved legacy decision." },
      actor
    );
    assert.equal(subject.source.faux.state.callCount, 1);
    await assert.rejects(
      subject.scope.acceptLegacyInput(
        { operationId: "slack:saved", text: "Changed saved text." },
        actor
      )
    );
  } finally {
    await subject.close();
  }
});

test("forks do not copy source admission or reminder origins and close under their own destination identity", async () => {
  const subject = await setupWeb();
  try {
    const input = await subject.source.native.submit(
      { type: "input", content: "Retain the historical fork point." },
      context
    );
    const done = await input.wait(context);
    assert.equal(done.status, "done");
    assert.ok(done.entry);
    await subject.fixture.pi().commit(async (tx) => {
      const saved = await tx.doc(
        ReminderOrigins,
        subject.source.native.id,
        "parent-timer",
        null
      );
      saved.record = { creatingEventId: null, reply: { kind: "web" } };
    }, context);
    await cutover(subject).restore();
    const fork = await subject.source.native.fork(
      done.entry,
      { ownership: { kind: "ownerless" } },
      context
    );
    const state = await subject.fixture
      .pi()
      .snapshot(SourceAdmission, fork.id, context);
    assert.equal(state?.state.kind ?? "open", "open");
    const origin = await subject.fixture
      .pi()
      .snapshot(ReminderOrigins, fork.id, "parent-timer", context);
    assert.equal(origin?.record ?? null, null);
    const address = {
      ...subject.source.address,
      conversationId: id.conversation("explicit-fork"),
      sessionId: id.session("explicit-fork-session"),
    };
    const admission = createSourceAdmission({
      pi: subject.fixture.pi(),
      nativeId: fork.id,
      address,
      primary: primary(subject),
      busy: () => false,
      jobs: subject.fixture.lifecycleJobs,
      persist: () => Promise.resolve(),
    });
    await admission.restore();
    await admission.advance();
    assert.deepEqual(await admission.read(), {
      kind: "archived",
      primary: primary(subject),
    });
  } finally {
    await subject.close();
  }
});

test("a local native continuation blocks archive while remote Team reservations remain independent", async () => {
  const subject = await setupWeb(true);
  let local = true;
  try {
    subject.source.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("start_team", { goal: "Keep independent work running." }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("The team is running independently."),
    ]);
    const savedResult22 = await subject.send(
      "team-before-pause",
      "Start independent work."
    );
    assert.equal(savedResult22.status, 200);
    await until(async () =>
      Boolean(await subject.scope.coordination.current())
    );
    await subject.source.native.waitForIdle(context);
    await subject.fixture.waitDispatch(1);
    const work = await subject.scope.coordination.current();
    assert.ok(work);
    const source = cutover(subject, () => local);
    await source.restore();
    assert.ok(await source.advance());
    local = false;
    await source.advance();
    const savedResult23 = await source.read();
    assert.equal(savedResult23.kind, "archived");
    const savedResult24 = await subject.scope.coordination.current();
    assert.equal(savedResult24?.workId, work.workId);
    assert.equal(subject.fixture.calls.length, 1);
  } finally {
    await subject.close();
  }
});

test("native drain reaches a nonterminal task after the first task page", async () => {
  const subject = await setupWeb();
  const task = defineTask<
    { hold: boolean },
    { phase: "run" },
    { done: boolean }
  >({
    name: "cutover-page-task",
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (saved, runtime, invocation) => {
        if (saved.input.hold) {
          await runtime.sleep(Date.now() + 60_000, invocation);
        }
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: { done: true } },
          }),
          invocation
        );
      },
    },
  });
  try {
    subject.fixture
      .registry()
      .install({ name: "cutover-page-fixture", tasks: [task] });
    const ids = await subject.fixture.pi().commit(async (tx) => {
      const result = [];
      for (let index = 0; index < 66; index += 1) {
        result.push(
          // oxlint-disable-next-line no-await-in-loop -- These tasks are admitted on the same native transaction line.
          await tx.createTask(
            task,
            { hold: index === 65 },
            {
              conversationId: subject.source.native.id,
              ownership: { kind: "conversation" },
              background: true,
            }
          )
        );
      }
      return result;
    }, context);
    await Promise.all(
      ids
        .slice(0, 65)
        .map((taskId) => subject.fixture.pi().waitForTask(taskId, context))
    );
    const source = cutover(subject);
    await source.restore();
    assert.ok(await source.advance());
    const savedResult25 = await source.read();
    assert.equal(savedResult25.kind, "paused");
    const last = ids.at(-1);
    assert.ok(last);
    await subject.fixture.pi().abortTask(last, context);
    await subject.fixture.pi().waitForTask(last, context);
    await source.advance();
    const savedResult26 = await source.read();
    assert.equal(savedResult26.kind, "archived");
  } finally {
    await subject.close();
  }
});
