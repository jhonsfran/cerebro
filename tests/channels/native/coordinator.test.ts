/* oxlint-disable unicorn/no-await-expression-member -- Queue faults and source-specific recovery checkpoints require ordered effects. */
import assert from "node:assert/strict";
import { before as beforeAll, test } from "node:test";

import { z } from "zod";

import { waitForFixture } from "../../slice-1/application.ts";
import { cellInventory } from "./cell-evidence.ts";
import { inspect, overview } from "./inspection-support.ts";
import {
  matchingSlackDelivery,
  slackAnswer,
  slackInputEvidence,
  slackReportEvidence,
  slackWork,
} from "./slack-team-support.ts";
import {
  matchingWorkReport,
  reportEvent,
  reportInputDigest,
} from "./team-queue-support.ts";
import {
  completedCalls,
  compose,
  configure,
  controlQueue,
  docker,
  drained,
  event,
  evidence,
  fixture,
  hasReply,
  metadata,
  observed,
  primaryDecision,
  queue,
  ready,
  send,
  snapshot,
  teamRoles,
} from "./team-support.ts";
import {
  access,
  createConversation,
  read,
  sendMessage,
  startedWork,
  stopWork,
  waitStartedWork,
  waitWorkReport,
} from "./web-team-support.ts";

let installed: Awaited<ReturnType<typeof configure>>;
beforeAll(
  async () => {
    installed = await configure();
  },
  { timeout: 180_000 }
);
const reportAnswer = (text: string) =>
  `Team report received. ${text.slice(0, 2000)}`;

test(
  "two signed Slack threads and web chat share one primary while reply authority stays with each external event",
  { timeout: 180_000 },
  async () => {
    await controlQueue("pause");
    try {
      const opened = await createConversation(installed.coordinator.agentId);
      const baseline = await read(opened.route);
      const ids = new Set(
        baseline.snapshot.messages.map((message) => message.id)
      );
      const input = event(
        "primary-storage-work",
        "PERSISTENT_AGENT_FIXTURE storage:slack-primary. Compare correctness and effort for an offline five-person tracker.",
        "1800020000.000001"
      );
      const beforeWork = await observed();
      const target = await slackWork(
        input,
        installed.coordinator.agentId,
        "storage:slack-primary"
      );
      assert.equal(
        target.sourceEventAddress.conversationId,
        opened.conversation.conversationId
      );
      const waiting = await waitWorkReport("cerebro-team-reports", target);
      const delivery = matchingWorkReport(waiting, target);
      assert.ok(
        delivery?.kind === "report" && delivery.wire.report.kind === "completed"
      );
      const other = event(
        "primary-ordinary-thread",
        "Give one ordinary answer about tomorrow's meeting.",
        "1800020001.000001"
      );
      const beforeOther = await observed();
      await Promise.all([
        send(other),
        sendMessage(opened.route, {
          operationId: crypto.randomUUID(),
          text: "Give one ordinary web answer while the private report waits.",
        }),
      ]);
      await waitForFixture(
        observed,
        (value) =>
          hasReply(value, other.event.ts, "Cerebro slice 1 completed.") &&
          completedCalls(value, teamRoles.coordinator).length ===
            completedCalls(beforeOther, teamRoles.coordinator).length + 2
      );
      const beforeDrain = await observed();
      const expectedInput = await reportInputDigest(delivery.wire, "pilot");
      const expectedReply = slackAnswer(
        reportAnswer(delivery.wire.report.text)
      );
      await controlQueue("resume");
      await drained("cerebro-team-reports");
      const completed = await waitForFixture(
        observed,
        (value) =>
          completedCalls(value, teamRoles.coordinator).length ===
            completedCalls(beforeDrain, teamRoles.coordinator).length + 1 &&
          value.model.some(
            (call) =>
              call.completedAt !== undefined &&
              call.messageTextDigests.includes(expectedInput)
          ) &&
          hasReply(value, input.event.ts, expectedReply)
      );
      const view = await waitForFixture(
        () => read(opened.route),
        (value) =>
          !value.snapshot.busy &&
          value.snapshot.messages.some(
            (message) =>
              !ids.has(message.id) &&
              message.text ===
                reportAnswer(
                  delivery.wire.report.kind === "completed"
                    ? delivery.wire.report.text
                    : ""
                )
          )
      );
      const started = startedWork(view.snapshot, input.event.text);
      assert.ok(started);
      assert.deepEqual(started.key, target.key);
      const one = await snapshot(input.event_id, installed.coordinator.agentId);
      const two = await snapshot(other.event_id, installed.coordinator.agentId);
      assert.equal(one.conversationId, two.conversationId);
      const admitted = await slackInputEvidence({
        admitted: one,
        before: beforeWork,
        physical: target.physical,
        requestCount: 2,
        answer: target.acknowledgement.text,
      });
      assert.equal(
        view.snapshot.messages.filter(
          (message) =>
            !ids.has(message.id) &&
            message.role === "user" &&
            message.text === input.event.text
        ).length,
        0
      );
      assert.equal(
        completed.slack.messages.filter(
          (message) =>
            message.threadTs === input.event.ts &&
            message.text === target.acknowledgement.text
        ).length,
        1
      );
      const reportReply = await slackReportEvidence({
        origin: target,
        delivery: delivery.wire,
        snapshot: view.snapshot,
        before: beforeDrain,
        physical: completed,
      });
      assert.equal(
        completed.slack.messages.filter(
          (message) =>
            message.text === "Cerebro slice 1 completed." &&
            message.threadTs === other.event.ts
        ).length,
        1
      );
      await send(input, true);
      await send(other, true);
      await drained("cerebro-slack-events");
      const replay = await observed();
      assert.equal(replay.model.length, completed.model.length);
      assert.equal(replay.slack.calls.length, completed.slack.calls.length);
      await evidence("native-shared-primary-slack-web", {
        opened: opened.conversation,
        baseline,
        input,
        target,
        beforeWork,
        admitted,
        other,
        beforeOther,
        waiting,
        delivery,
        expectedInput,
        expectedReply,
        reportReply,
        completed,
        view,
        one,
        two,
        replay,
      });
    } finally {
      await controlQueue("resume");
    }
  }
);

test(
  "a signed Slack Team recovers on the same volume and reports before any post-kill source reader",
  { timeout: 180_000 },
  async () => {
    await controlQueue("pause");
    await fixture.controls({
      models: { [teamRoles.lead]: { hold: true, delayMs: 0 } },
    });
    try {
      const input = event(
        "primary-slack-recovery",
        "PERSISTENT_AGENT_FIXTURE slack:slack-recovery. Review filtering and uncertain physical delivery.",
        "1800020100.000001"
      );
      const before = await observed();
      const target = await slackWork(
        input,
        installed.coordinator.agentId,
        "slack:slack-recovery"
      );
      const accepted = await waitStartedWork(target.route, input.event.text);
      assert.ok(accepted.work);
      assert.deepEqual(accepted.work.key, target.key);
      const ids = new Set(
        accepted.view.snapshot.messages.map((message) => message.id)
      );
      const held = await waitForFixture(observed, (value) => value.held > 0);
      const pending = held.model
        .slice(before.model.length)
        .find(
          (call) =>
            call.role === teamRoles.lead && call.completedAt === undefined
        );
      assert.ok(pending);
      const celld = await fixture.container("celld");
      const mountSchema = z.array(
        z.object({
          Id: z.string(),
          Mounts: z.array(
            z.object({
              Type: z.string(),
              Name: z.string().optional(),
              Source: z.string(),
              Destination: z.string(),
            })
          ),
        })
      );
      const mounts = mountSchema.parse(
        JSON.parse((await docker("inspect", celld)).stdout)
      );
      const killedAt = Date.now();
      await docker("kill", "--signal", "KILL", celld);
      await compose("up", "--no-deps", "-d", "--wait", "celld");
      await ready();
      assert.deepEqual(
        mountSchema.parse(JSON.parse((await docker("inspect", celld)).stdout)),
        mounts
      );
      await fixture.controls({ models: {}, release: true });
      const physical = await waitForFixture(
        observed,
        (value) =>
          value.model.some(
            (call) =>
              call.role === teamRoles.lead &&
              call.operationId === pending.operationId &&
              call.startedAt > killedAt &&
              call.completedAt !== undefined
          ) &&
          completedCalls(value, teamRoles.worker).length ===
            completedCalls(before, teamRoles.worker).length + 2,
        90_000
      );
      const physicalAt = Date.now();
      const waiting = await waitWorkReport("cerebro-team-reports", target);
      const delivery = matchingWorkReport(waiting, target);
      assert.ok(
        delivery?.kind === "report" && delivery.wire.report.kind === "completed"
      );
      const expectedInput = await reportInputDigest(delivery.wire, "pilot");
      const expectedReply = slackAnswer(
        reportAnswer(delivery.wire.report.text)
      );
      const queuedAt = Date.now();
      await controlQueue("resume");
      await drained("cerebro-team-reports");
      const completed = await waitForFixture(
        observed,
        (value) =>
          completedCalls(value, teamRoles.coordinator).length ===
            completedCalls(before, teamRoles.coordinator).length + 3 &&
          value.model.some(
            (call) =>
              call.role === teamRoles.coordinator &&
              call.startedAt >= queuedAt &&
              call.completedAt !== undefined &&
              call.messageTextDigests.includes(expectedInput)
          ) &&
          hasReply(value, input.event.ts, expectedReply)
      );
      const firstReadAt = Date.now();
      assert.ok(
        killedAt < physicalAt &&
          physicalAt <= queuedAt &&
          queuedAt <= firstReadAt
      );
      const view = await waitForFixture(
        () => read(target.route),
        (value) =>
          !value.snapshot.busy &&
          value.snapshot.messages.some(
            (message) =>
              !ids.has(message.id) &&
              message.text ===
                reportAnswer(
                  delivery.wire.report.kind === "completed"
                    ? delivery.wire.report.text
                    : ""
                )
          )
      );
      assert.deepEqual(
        view.snapshot.messages.filter((message) => ids.has(message.id)),
        accepted.view.snapshot.messages
      );
      const saved = startedWork(view.snapshot, input.event.text);
      assert.ok(saved);
      assert.equal(saved.call.id, accepted.work.call.id);
      assert.equal(
        saved.call.resultMessageId,
        accepted.work.call.resultMessageId
      );
      assert.equal(
        view.snapshot.messages.filter(
          (message) =>
            !ids.has(message.id) &&
            message.role === "assistant" &&
            message.text.startsWith("Team report received.")
        ).length,
        1
      );
      const reportReply = await slackReportEvidence({
        origin: target,
        delivery: delivery.wire,
        snapshot: view.snapshot,
        before: physical,
        physical: completed,
      });
      await send(input, true);
      await drained("cerebro-slack-events");
      const replay = await observed();
      assert.equal(replay.model.length, completed.model.length);
      assert.equal(replay.slack.calls.length, completed.slack.calls.length);
      assert.deepEqual(await read(target.route), view);
      await evidence("native-slack-no-reader-recovery", {
        input,
        target,
        accepted,
        pending,
        mounts,
        celld,
        killedAt,
        physicalAt,
        physical,
        waiting,
        delivery,
        queuedAt,
        expectedInput,
        expectedReply,
        reportReply,
        completed,
        firstReadAt,
        view,
        replay,
      });
    } finally {
      await fixture.controls({ models: {}, release: true });
      await controlQueue("resume");
    }
  }
);

test(
  "owned PostgreSQL failure sends the exact signed callback to the native DLQ and redrive admits it once",
  { timeout: 360_000 },
  async () => {
    const input = event(
      "primary-pg-failure",
      "Give one ordinary answer after storage recovers.",
      "1800020200.000001"
    );
    const opened = await createConversation(installed.coordinator.agentId);
    const baseline = await read(opened.route);
    const messageIds = new Set(
      baseline.snapshot.messages.map((message) => message.id)
    );
    const before = await observed();
    const postgres = await fixture.container("postgres");
    let failed;
    await docker("stop", postgres);
    try {
      await send(input);
      failed = await waitForFixture(
        () => queue("peek", "cerebro-slack-events-dead-letter", 20),
        (value) =>
          matchingSlackDelivery(value, input, installed.coordinator.agentId) !==
          undefined,
        240_000
      );
      assert.ok(
        matchingSlackDelivery(failed, input, installed.coordinator.agentId)
      );
    } finally {
      await docker("start", postgres);
      await waitForFixture(
        async () => {
          try {
            return await fixture.sql("SELECT 1");
          } catch {
            return "";
          }
        },
        (value) => value === "1",
        60_000
      );
    }
    const redrive = await queue(
      "redrive",
      "cerebro-slack-events-dead-letter",
      20
    );
    const completed = await waitForFixture(
      observed,
      (value) => hasReply(value, input.event.ts, "Cerebro slice 1 completed."),
      60_000
    );
    const saved = await primaryDecision(input.event_id);
    const view = await snapshot(input.event_id, installed.coordinator.agentId);
    const admitted = await slackInputEvidence({
      admitted: view,
      before,
      physical: completed,
      requestCount: 1,
      answer: "Cerebro slice 1 completed.",
    });
    assert.equal(
      view.snapshot.messages.filter(
        (message) =>
          !messageIds.has(message.id) &&
          message.role === "user" &&
          message.text === input.event.text
      ).length,
      0
    );
    assert.equal(completed.model.length, before.model.length + 1);
    const repeated = await queue(
      "redrive",
      "cerebro-slack-events-dead-letter",
      20
    );
    assert.equal(
      z.object({ redriven: z.number() }).parse(repeated).redriven,
      0
    );
    await send(input, true);
    await drained("cerebro-slack-events");
    assert.equal((await observed()).model.length, completed.model.length);
    await evidence("native-slack-pg-redrive", {
      input,
      postgres,
      before,
      failed,
      redrive,
      completed,
      saved,
      view,
      baseline,
      admitted,
      repeated,
    });
  }
);

test(
  "current source denial retains an exact completed Slack-origin report for one internal coordinator redrive",
  { timeout: 300_000 },
  async () => {
    await controlQueue("pause");
    let revoked = false;
    try {
      const input = event(
        "primary-report-denial",
        "PERSISTENT_AGENT_FIXTURE slack:report-denial. Review reply authority and unknown delivery.",
        "1800020300.000001"
      );
      const target = await slackWork(
        input,
        installed.coordinator.agentId,
        "slack:report-denial"
      );
      const accepted = await waitStartedWork(target.route, input.event.text);
      assert.ok(accepted.work);
      const ids = new Set(
        accepted.view.snapshot.messages.map((message) => message.id)
      );
      const waiting = await waitWorkReport("cerebro-team-reports", target);
      const delivery = matchingWorkReport(waiting, target);
      assert.ok(
        delivery?.kind === "report" && delivery.wire.report.kind === "completed"
      );
      const before = await observed();
      await access(
        ["execute"],
        metadata.agent.principalId,
        installed.coordinator.agentId
      );
      revoked = true;
      await controlQueue("resume");
      const deadLetter = await waitWorkReport(
        "cerebro-team-reports-dead-letter",
        target,
        180_000,
        delivery.wire.report.id
      );
      assert.equal((await observed()).model.length, before.model.length);
      await access(
        ["read", "execute", "approve"],
        metadata.agent.principalId,
        installed.coordinator.agentId
      );
      revoked = false;
      const expectedInput = await reportInputDigest(delivery.wire, "pilot");
      const expectedReply = slackAnswer(
        reportAnswer(delivery.wire.report.text)
      );
      const redrive = await queue(
        "redrive",
        "cerebro-team-reports-dead-letter",
        10
      );
      await drained("cerebro-team-reports");
      const completed = await waitForFixture(
        observed,
        (value) =>
          value.model.length === before.model.length + 1 &&
          value.model.some(
            (call) =>
              call.completedAt !== undefined &&
              call.messageTextDigests.includes(expectedInput)
          ) &&
          hasReply(value, input.event.ts, expectedReply)
      );
      const view = await waitForFixture(
        () => read(target.route),
        (value) =>
          !value.snapshot.busy &&
          value.snapshot.messages.some(
            (message) =>
              !ids.has(message.id) &&
              message.text.startsWith("Team report received.")
          )
      );
      const events = await inspect(target.route, { kind: "events" });
      assert.ok(events.kind === "events");
      const expected = await reportEvent(delivery.wire);
      assert.equal(
        events.events.filter(
          (item) => item.id === expected.id && item.outcome === "done"
        ).length,
        1
      );
      const reportReply = await slackReportEvidence({
        origin: target,
        delivery: delivery.wire,
        snapshot: view.snapshot,
        before,
        physical: completed,
      });
      const repeated = await queue(
        "redrive",
        "cerebro-team-reports-dead-letter",
        10
      );
      assert.equal(
        z.object({ redriven: z.number() }).parse(repeated).redriven,
        0
      );
      assert.deepEqual(await read(target.route), view);
      await evidence("native-slack-report-authority", {
        input,
        target,
        accepted,
        waiting,
        delivery,
        before,
        deadLetter,
        redrive,
        expectedInput,
        expectedReply,
        reportReply,
        completed,
        view,
        events,
        repeated,
      });
    } finally {
      if (revoked) {
        await access(
          ["read", "execute", "approve"],
          metadata.agent.principalId,
          installed.coordinator.agentId
        );
      }
      await controlQueue("resume");
    }
  }
);

test(
  "web and Slack goals share two active reservations and a queued cancellation dispatches no Team",
  { timeout: 180_000 },
  async () => {
    await fixture.controls({
      models: { [teamRoles.lead]: { hold: true, delayMs: 0 } },
    });
    await controlQueue("pause");
    try {
      const opened = await createConversation(installed.coordinator.agentId);
      const webGoal =
        "PERSISTENT_AGENT_FIXTURE storage:mixed-web. Compare client storage effort.";
      await sendMessage(opened.route, {
        operationId: crypto.randomUUID(),
        text: webGoal,
      });
      const web = await waitStartedWork(opened.route, webGoal);
      assert.ok(web.work);
      const webTarget = web.work;
      const slackInput = event(
        "mixed-slack-active",
        "PERSISTENT_AGENT_FIXTURE slack:mixed-slack. Review filtering and reply authority.",
        "1800020400.000001"
      );
      const active = await slackWork(
        slackInput,
        installed.coordinator.agentId,
        "slack:mixed-slack"
      );
      assert.equal(
        active.sourceEventAddress.conversationId,
        opened.conversation.conversationId
      );
      await waitForFixture(observed, (value) => value.held === 2);
      const queuedInput = event(
        "mixed-slack-queued",
        "PERSISTENT_AGENT_FIXTURE storage:mixed-queued. Review offline migration effort.",
        "1800020401.000001"
      );
      const queued = await slackWork(
        queuedInput,
        installed.coordinator.agentId,
        "storage:mixed-queued"
      );
      assert.equal(queued.status, "queued");
      const calibration = await waitForFixture(
        () =>
          Promise.all([
            cellInventory(webTarget.key),
            cellInventory(active.key),
          ]),
        (values) => values.every((value) => value.local && value.bucket)
      );
      const absent = await cellInventory(queued.key);
      assert.deepEqual(
        { local: absent.local, bucket: absent.bucket },
        { local: false, bucket: false }
      );
      const frame = await inspect(opened.route, {
        kind: "team",
        workId: queued.key.workId,
      });
      assert.ok(frame.kind === "team");
      assert.deepEqual(frame.team, { kind: "not-started" });
      await stopWork(opened.route, queued.key.workId);
      assert.deepEqual(await cellInventory(queued.key), absent);
      await stopWork(opened.route, webTarget.key.workId);
      await stopWork(opened.route, active.key.workId);
      await fixture.controls({ models: {}, release: true });
      const reports = await Promise.all([
        waitWorkReport("cerebro-team-reports", webTarget),
        waitWorkReport("cerebro-team-reports", active),
      ]);
      await controlQueue("resume");
      await drained("cerebro-team-reports");
      const final = await waitForFixture(
        () => overview(opened.route),
        (value) =>
          [webTarget.key.workId, active.key.workId, queued.key.workId].every(
            (id) =>
              value.work.some(
                (work) => work.workId === id && !work.reservationHeld
              )
          )
      );
      assert.deepEqual(await cellInventory(queued.key), absent);
      await evidence("native-web-slack-global-capacity", {
        conversation: opened.conversation,
        web,
        slackInput,
        active,
        queuedInput,
        queued,
        calibration,
        absent,
        frame,
        reports,
        final,
      });
    } finally {
      await fixture.controls({ models: {}, release: true });
      await controlQueue("resume");
    }
  }
);
