/* oxlint-disable unicorn/no-await-expression-member -- Subscription transitions, controlled responses, and cold replay require ordered effects. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before as beforeAll, test } from "node:test";

import { Schema } from "effect";
import { z } from "zod";

import {
  BotEventSourceSchema,
  botEventId,
} from "../../../packages/contracts/src/bot-events.ts";
import {
  authorizedPilotInput,
  waitForFixture,
} from "../../slice-1/application.ts";
import {
  admitReference,
  queuedTeamEvent,
  stopSubscriptionWork,
  subscribeLiveWork,
} from "./event-team-support.ts";
import { inspect, overview, waitTeamAdmission } from "./inspection-support.ts";
import { matchingSlackDelivery } from "./slack-team-support.ts";
import {
  matchingEventReturn,
  matchingTeamEvent,
  matchingWorkReport,
  reportEvent,
  reportInputDigest,
} from "./team-queue-support.ts";
import {
  compose,
  configure,
  controlQueue,
  drained,
  event,
  evidence,
  fixture,
  hasReply,
  literal,
  metadata,
  observed,
  primaryDecision,
  queue,
  ready,
  selectSlackAgent,
  send,
  slack,
  wireModels,
} from "./team-support.ts";
import {
  access,
  createConversation,
  publishedSchema,
  sendTurn,
  stopWork,
  waitWorkReport,
} from "./web-team-support.ts";

let installed: Awaited<ReturnType<typeof configure>>;
let currentAgentId: string;
beforeAll(
  async () => {
    installed = await configure();
    currentAgentId = installed.coordinator.agentId;
  },
  { timeout: 180_000 }
);

test(
  "an admitted model reference subscribes real Work, related input reaches its Team, and unsubscribe changes only future routing",
  { timeout: 240_000 },
  async () => {
    await controlQueue("pause");
    try {
      const reference = await admitReference(
        installed.coordinator.agentId,
        "storage:subscription-a",
        "subscription-reference-a",
        "1800030000.000001"
      );
      const live = await subscribeLiveWork(reference);
      const baseline = await observed();
      const related = event(
        "subscription-related-a",
        "Keep offline edits recoverable after a local crash.",
        "1800030001.000001",
        reference.thread
      );
      const delivered = await queuedTeamEvent(live, related);
      assert.ok(delivered.command.event);
      const saved = await primaryDecision(related.event_id);
      assert.equal(saved.decision.targets.length, 1);
      await fixture.controls({ release: true });
      const completed = await waitForFixture(observed, (value) =>
        value.model.some(
          (call) =>
            call.model === wireModels.lead &&
            call.completedAt !== undefined &&
            call.messageTextDigests.includes(delivered.digest)
        )
      );
      assert.equal(
        completed.model.filter((call) => call.model === wireModels.coordinator)
          .length,
        baseline.model.filter((call) => call.model === wireModels.coordinator)
          .length
      );
      const transcript = await inspect(live.route, {
        kind: "transcript",
        workId: live.target.key.workId,
        role: 0,
      });
      assert.ok(transcript.kind === "transcript");
      assert.ok(
        transcript.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content.text ===
              `Related constraint retained: ${related.event.text}`
        )
      );
      const unsubscribed = await sendTurn(
        live.route,
        "PERSISTENT_AGENT_FIXTURE unsubscribe storage:subscription-a. Stop following this thread."
      );
      const remove = unsubscribed.tools.filter(
        (tool) => tool.toolName === "unsubscribe_work"
      );
      assert.equal(remove.length, 1);
      assert.deepEqual(remove[0]?.arguments, live.args);
      await controlQueue("pause", "cerebro-team-commands");
      const next = event(
        "subscription-after-remove",
        "Give one ordinary answer after the explicit unsubscribe.",
        "1800030002.000001",
        reference.thread
      );
      await send(next);
      const answered = await waitForFixture(observed, (value) =>
        hasReply(value, reference.thread, "Cerebro slice 1 completed.")
      );
      const waiting = await queue("peek", "cerebro-team-commands", 50);
      assert.equal(
        matchingTeamEvent(waiting, live.target, next.event_id),
        undefined
      );
      const nextDecision = await primaryDecision(next.event_id);
      const expectedId = await botEventId(
        live.target.sourceEventAddress,
        Schema.decodeUnknownSync(BotEventSourceSchema)({
          kind: "slack",
          eventId: nextDecision.decision.authority.eventId,
          thread: nextDecision.decision.authority.thread,
        })
      );
      const events = await inspect(live.route, { kind: "events" });
      assert.ok(events.kind === "events");
      assert.ok(
        events.events.some(
          (item) => item.id === expectedId && item.route === "coordinator"
        )
      );
      await send(related, true);
      await drained("cerebro-slack-events");
      const replayEvents = await inspect(live.route, { kind: "events" });
      assert.ok(replayEvents.kind === "events");
      assert.ok(
        replayEvents.events.some(
          (item) =>
            item.id === delivered.command.event?.id &&
            item.route === "teams" &&
            item.duplicates >= 1
        )
      );
      await controlQueue("resume", "cerebro-team-commands");
      await fixture.controls({ models: {}, release: true });
      const reports = await waitWorkReport("cerebro-team-reports", live.target);
      await controlQueue("resume");
      const report = matchingWorkReport(reports, live.target);
      assert.ok(report?.kind === "report");
      const expectedInput = await reportInputDigest(report.wire, "pilot");
      const expectedEvent = await reportEvent(report.wire);
      const finished = await waitForFixture(observed, (value) =>
        value.model.some(
          (call) =>
            call.model === wireModels.coordinator &&
            call.completedAt !== undefined &&
            call.messageTextDigests.includes(expectedInput)
        )
      );
      const settled = await waitForFixture(
        () => inspect(live.route, { kind: "events" }),
        (value) =>
          value.kind === "events" &&
          value.events.some(
            (item) => item.id === expectedEvent.id && item.outcome === "done"
          )
      );
      assert.ok(settled.kind === "events");
      assert.equal(
        settled.events.find((item) => item.id === expectedEvent.id)?.reply,
        null
      );
      const afterSettlement = await observed();
      assert.equal(
        afterSettlement.slack.calls.length,
        answered.slack.calls.length
      );
      await evidence("native-explicit-subscription", {
        reference,
        live,
        related,
        delivered,
        saved,
        transcript,
        unsubscribed,
        next,
        answered,
        waiting,
        events,
        replayEvents,
        reports,
        expectedInput,
        expectedEvent,
        finished,
        settled,
        afterSettlement,
      });
    } finally {
      await fixture.controls({ models: {}, release: true });
      await controlQueue("resume", "cerebro-team-commands");
      await controlQueue("resume");
    }
  }
);

test(
  "an unrelated subscribed event returns once through the real outbox while the private Team remains running",
  { timeout: 240_000 },
  async () => {
    await controlQueue("pause");
    try {
      const reference = await admitReference(
        installed.coordinator.agentId,
        "slack:handback-a",
        "handback-reference-a",
        "1800030100.000001"
      );
      const live = await subscribeLiveWork(reference);
      const unrelated = event(
        "handback-unrelated-a",
        "PERSISTENT_AGENT_FIXTURE unrelated What time is the planning meeting?",
        "1800030101.000001",
        reference.thread
      );
      const delivered = await queuedTeamEvent(live, unrelated);
      assert.ok(delivered.command.event);
      const eventMetadata = delivered.command.event;
      const beforeReturn = await observed();
      await fixture.controls({ release: true });
      const pending = await waitForFixture(
        () => queue("peek", "cerebro-team-reports", 50),
        (value) =>
          matchingEventReturn(value, live.target, eventMetadata) !== undefined,
        60_000
      );
      const returned = matchingEventReturn(pending, live.target, eventMetadata);
      assert.ok(returned?.kind === "event-return");
      const running = await inspect(live.route, {
        kind: "team",
        workId: live.target.key.workId,
      });
      assert.ok(running.kind === "team" && running.team.kind === "available");
      assert.equal(running.team.sealed, false);
      assert.equal(running.team.phase, "running");
      const nextHeld = await waitForFixture(
        observed,
        (value) =>
          value.held > 0 &&
          value.model.filter(
            (call) =>
              call.model === wireModels.lead &&
              call.messageTextDigests.includes(delivered.digest)
          ).length >= 2
      );
      const transcript = await inspect(live.route, {
        kind: "transcript",
        workId: live.target.key.workId,
        role: 0,
      });
      assert.ok(transcript.kind === "transcript");
      const returns = transcript.tools.filter(
        (tool) => tool.name === "return_event"
      );
      assert.equal(returns.length, 1);
      assert.equal(returns[0]?.status, "succeeded");
      await controlQueue("resume");
      await drained("cerebro-team-reports");
      const answer =
        "The request is ordinary conversation. No team work was started.";
      const handled = await waitForFixture(
        observed,
        (value) => hasReply(value, reference.thread, answer),
        60_000
      );
      assert.equal(
        handled.model.filter((call) => call.model === wireModels.coordinator)
          .length,
        beforeReturn.model.filter(
          (call) => call.model === wireModels.coordinator
        ).length + 1
      );
      assert.equal(
        handled.slack.messages.filter(
          (message) =>
            message.threadTs === reference.thread && message.text === answer
        ).length,
        1
      );
      assert.equal(
        handled.slack.messages.some((message) =>
          message.text.includes(
            "This request is unrelated to the assigned task."
          )
        ),
        false
      );
      const active = await overview(live.route);
      assert.ok(
        active.work.some(
          (work) =>
            work.workId === live.target.key.workId &&
            work.reservationHeld &&
            work.status !== "cancelled"
        )
      );
      await send(unrelated, true);
      await drained("cerebro-slack-events");
      const repeated = await observed();
      assert.equal(repeated.model.length, handled.model.length);
      assert.equal(repeated.slack.calls.length, handled.slack.calls.length);
      const events = await inspect(live.route, { kind: "events" });
      assert.ok(events.kind === "events");
      const saved = events.events.find(
        (item) => item.id === returned.wire.eventId
      );
      assert.equal(
        saved?.returns.filter(
          (item) =>
            item.workId === live.target.key.workId &&
            item.decision === "returned"
        ).length,
        1
      );
      const reports = await stopSubscriptionWork(live);
      await evidence("native-one-time-handback", {
        reference,
        live,
        unrelated,
        delivered,
        pending,
        returned,
        running,
        nextHeld,
        transcript,
        handled,
        active,
        repeated,
        events,
        reports,
      });
    } finally {
      await fixture.controls({ models: {}, release: true });
      await controlQueue("resume", "cerebro-team-commands");
      await controlQueue("resume");
    }
  }
);

test(
  "two genuine bot references freeze both targets before unsubscribe and independent current authority denial",
  { timeout: 300_000 },
  async () => {
    const prior = await createConversation(installed.coordinator.agentId);
    const beforePriorReports = await overview(prior.route);
    await controlQueue("resume");
    await drained("cerebro-team-reports");
    const settledPriorReports = await waitForFixture(
      () => overview(prior.route),
      (value) => value.work.every((work) => !work.reservationHeld),
      60_000
    );
    await controlQueue("pause");
    let denied = false;
    try {
      const root = "1800030200.000001";
      const one = await admitReference(
        installed.coordinator.agentId,
        "slack:fanout-a",
        "fanout-reference-a",
        root
      );
      const secondary = await fixture.json(
        "/api/product/agents",
        metadata.owner.cookie,
        publishedSchema,
        {
          operationId: crypto.randomUUID(),
          name: "Second persistent bot",
          model: "fixture/slack-coordinator",
          instructions: "Coordinate only the current owned work.",
          enabledToolIds: [],
          grants: [
            {
              action: "read",
              resource: {
                id: "pilot-source",
                kind: "memory",
                organizationId: metadata.agent.organizationId,
              },
            },
          ],
        }
      );
      await selectSlackAgent(secondary.agentId, {
        leadAgentId: installed.lead.agentId,
        workerAgentId: installed.worker.agentId,
      });
      currentAgentId = secondary.agentId;
      const two = await admitReference(
        secondary.agentId,
        "slack:fanout-b",
        "fanout-reference-b",
        root
      );
      assert.deepEqual(
        one.saved.decision.targets.map((target) => target.agentId),
        [installed.coordinator.agentId]
      );
      assert.deepEqual(
        two.saved.decision.targets.map((target) => target.agentId),
        [secondary.agentId]
      );
      const liveA = await subscribeLiveWork(one);
      const liveB = await subscribeLiveWork(two);
      assert.equal(
        liveA.conversation.conversationId,
        prior.conversation.conversationId
      );
      assert.notEqual(
        liveA.conversation.conversationId,
        liveB.conversation.conversationId
      );
      await controlQueue("pause", "cerebro-team-commands");
      const input = event(
        "fanout-frozen-event",
        "Keep replies tied to the original thread and do not resend unknown posts.",
        "1800030201.000001",
        root
      );
      await send(input);
      const frozen = await primaryDecision(input.event_id);
      assert.deepEqual(
        frozen.decision.targets.map((target) => target.agentId).toSorted(),
        [installed.coordinator.agentId, secondary.agentId].toSorted()
      );
      const pending = await waitForFixture(
        () => queue("peek", "cerebro-team-commands", 50),
        (value) =>
          matchingTeamEvent(value, liveA.target, input.event_id) !==
            undefined &&
          matchingTeamEvent(value, liveB.target, input.event_id) !== undefined
      );
      const commandA = matchingTeamEvent(pending, liveA.target, input.event_id);
      const commandB = matchingTeamEvent(pending, liveB.target, input.event_id);
      assert.ok(commandA?.event && commandB?.event);
      assert.notEqual(commandA.event.id, commandB.event.id);
      const beforeAdmissionB = await inspect(liveB.route, {
        kind: "tasks",
        workId: liveB.target.key.workId,
        role: 0,
      });
      assert.ok(beforeAdmissionB.kind === "tasks");
      await sendTurn(
        liveB.route,
        "PERSISTENT_AGENT_FIXTURE unsubscribe slack:fanout-b. Stop future events from this thread."
      );
      await access(
        ["execute"],
        metadata.agent.principalId,
        installed.coordinator.agentId
      );
      denied = true;
      await fixture.controls({
        models: {
          [wireModels.lead]: { hold: true, delayMs: 500 },
          [wireModels.worker]: { hold: true, delayMs: 0 },
        },
      });
      await controlQueue("resume", "cerebro-team-commands");
      const admissionB = await waitTeamAdmission(
        liveB.route,
        liveB.target.key.workId,
        beforeAdmissionB
      );
      const blocked = await waitForFixture(
        () => queue("peek", "cerebro-team-commands-dead-letter", 50),
        (value) =>
          matchingTeamEvent(value, liveA.target, input.event_id) !== undefined,
        180_000
      );
      assert.deepEqual(await primaryDecision(input.event_id), frozen);
      assert.equal(
        matchingTeamEvent(blocked, liveB.target, input.event_id),
        undefined
      );
      await fixture.controls({
        models: {
          [wireModels.lead]: { hold: true, delayMs: 500 },
          [wireModels.worker]: { hold: false, delayMs: 0 },
        },
      });
      assert.ok(commandB.command.kind === "input");
      const digestB = createHash("sha256")
        .update(
          authorizedPilotInput(
            `External event ${commandB.event.id}. Use return_event if it is unrelated to this work.\n${commandB.command.text}`
          )
        )
        .digest("hex");
      const independent = await waitForFixture(
        observed,
        (value) =>
          value.model.some(
            (call) =>
              call.model === wireModels.lead &&
              call.completedAt === undefined &&
              call.messageTextDigests.includes(digestB)
          ),
        60_000
      );
      const deniedRead = await fixture.request(
        `${liveA.route}/inspection`,
        metadata.owner.cookie,
        { query: { kind: "events" } }
      );
      assert.equal(deniedRead.status, 403);
      await deniedRead.body?.cancel();
      await access(
        ["read", "execute", "approve"],
        metadata.agent.principalId,
        installed.coordinator.agentId
      );
      denied = false;
      const redrive = await queue(
        "redrive",
        "cerebro-team-commands-dead-letter",
        50
      );
      await drained("cerebro-team-commands");
      assert.deepEqual(await primaryDecision(input.event_id), frozen);
      await controlQueue("pause");
      await stopWork(liveA.route, liveA.target.key.workId);
      await stopWork(liveB.route, liveB.target.key.workId);
      await fixture.controls({ models: {}, release: true });
      const reports = await Promise.all([
        waitWorkReport("cerebro-team-reports", liveA.target),
        waitWorkReport("cerebro-team-reports", liveB.target),
      ]);
      await controlQueue("resume");
      await drained("cerebro-team-reports");
      await waitForFixture(
        () => overview(liveA.route),
        (value) =>
          value.work.some(
            (work) =>
              work.workId === liveA.target.key.workId && !work.reservationHeld
          )
      );
      await waitForFixture(
        () => overview(liveB.route),
        (value) =>
          value.work.some(
            (work) =>
              work.workId === liveB.target.key.workId && !work.reservationHeld
          )
      );
      await evidence("native-two-bot-frozen-targets", {
        prior,
        beforePriorReports,
        settledPriorReports,
        one,
        two,
        secondary,
        liveA,
        liveB,
        input,
        frozen,
        pending,
        commandA,
        commandB,
        admissionB,
        blocked,
        independent,
        redrive,
        reports,
      });
    } finally {
      if (denied) {
        await access(
          ["read", "execute", "approve"],
          metadata.agent.principalId,
          installed.coordinator.agentId
        );
      }
      await fixture.controls({ models: {}, release: true });
      await controlQueue("resume", "cerebro-team-commands");
      await controlQueue("resume");
    }
  }
);

test(
  "a physically accepted unknown Slack reply is never resent after signed replay, link denial, or cold reopen",
  { timeout: 300_000 },
  async () => {
    const thread = "1800030300.000001";
    const text = "Cerebro slice 1 completed.";
    const selector = {
      channel: "D-native-team",
      threadTs: thread,
      textSha256: createHash("sha256").update(text).digest("hex"),
    };
    await fixture.controls({
      slackPostUnknown: selector,
      models: {},
      release: true,
    });
    const input = event(
      "unknown-accepted-event",
      "Give one ordinary answer for this uncertain reply.",
      thread
    );
    const before = await observed();
    await send(input);
    const saved = await primaryDecision(input.event_id);
    const target = saved.decision.targets.find(
      (item) => item.agentId === currentAgentId
    );
    assert.ok(target);
    const route = `/api/product/conversations/${encodeURIComponent(target.conversationId)}`;
    const id = await botEventId(
      target,
      Schema.decodeUnknownSync(BotEventSourceSchema)({
        kind: "slack",
        eventId: saved.decision.authority.eventId,
        thread: saved.decision.authority.thread,
      })
    );
    const physical = await waitForFixture(observed, (value) =>
      value.slack.calls.some(
        (call) =>
          call.status === 503 &&
          call.request.channel === selector.channel &&
          call.request.thread_ts === thread &&
          call.request.text === text
      )
    );
    const unknown = await waitForFixture(
      () => inspect(route, { kind: "events" }),
      (value) =>
        value.kind === "events" &&
        value.events.some(
          (item) => item.id === id && item.reply?.state === "unknown"
        )
    );
    assert.equal(
      physical.slack.calls.filter(
        (call) =>
          call.request.channel === selector.channel &&
          call.request.thread_ts === thread &&
          call.request.text === text
      ).length,
      1
    );
    assert.equal(
      physical.slack.messages.filter(
        (message) =>
          message.channel === selector.channel &&
          message.threadTs === thread &&
          message.text === text
      ).length,
      1
    );
    const consumed = z
      .object({
        controls: z.object({
          slackPostUnknown: z.object({ consumedAt: z.number() }),
        }),
      })
      .parse(await fixture.observations());
    await send(input, true);
    await drained("cerebro-slack-events");
    assert.equal(
      (await observed()).slack.calls.length,
      physical.slack.calls.length
    );
    await fixture.sql(
      `DELETE FROM identity_slack_link WHERE workspace_id=${literal(slack.workspaceId)} AND slack_user_id='native-team-user'`
    );
    await send(input, true);
    const blocked = await waitForFixture(
      () => queue("peek", "cerebro-slack-events-dead-letter", 50),
      (value) =>
        matchingSlackDelivery(value, input, currentAgentId) !== undefined,
      180_000
    );
    assert.equal(
      (await observed()).slack.calls.length,
      physical.slack.calls.length
    );
    const link = await fixture.json(
      "/rpc/identity/beginSlackLink",
      metadata.owner.cookie,
      z.object({ json: z.object({ code: z.string() }) }),
      { json: { organizationId: metadata.agent.organizationId } }
    );
    await send(
      event(
        "unknown-link-restore",
        `link ${link.json.code}`,
        "1800030301.000001"
      )
    );
    await waitForFixture(
      () =>
        fixture.sql(
          `SELECT principal_id FROM identity_slack_link WHERE workspace_id=${literal(slack.workspaceId)} AND slack_user_id='native-team-user'`
        ),
      (value) => value === metadata.agent.principalId
    );
    await queue("redrive", "cerebro-slack-events-dead-letter", 50);
    await drained("cerebro-slack-events");
    const afterLink = await observed();
    const beforeCold = afterLink.slack.calls.filter(
      (call) =>
        call.request.channel === selector.channel &&
        call.request.thread_ts === thread &&
        call.request.text === text
    ).length;
    await compose("restart", "celld");
    await ready();
    await send(input, true);
    await drained("cerebro-slack-events");
    const reopened = await inspect(route, { kind: "events" });
    assert.ok(reopened.kind === "events");
    assert.equal(
      reopened.events.find((item) => item.id === id)?.reply?.state,
      "unknown"
    );
    const afterCold = await observed();
    assert.equal(
      afterCold.slack.calls.filter(
        (call) =>
          call.request.channel === selector.channel &&
          call.request.thread_ts === thread &&
          call.request.text === text
      ).length,
      beforeCold
    );
    const distinct = event(
      "unknown-distinct-success",
      "Give one ordinary answer for a distinct event.",
      "1800030302.000001"
    );
    await send(distinct);
    const success = await waitForFixture(observed, (value) =>
      hasReply(value, distinct.event.ts, text)
    );
    assert.equal(
      success.slack.calls.filter(
        (call) =>
          call.request.thread_ts === thread && call.request.text === text
      ).length,
      1
    );
    await evidence("native-unknown-post-no-resend", {
      input,
      selector,
      saved,
      target,
      id,
      before,
      physical,
      unknown,
      consumed,
      blocked,
      afterLink,
      beforeCold,
      reopened,
      afterCold,
      distinct,
      success,
    });
  }
);
