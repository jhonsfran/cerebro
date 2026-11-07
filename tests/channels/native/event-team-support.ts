import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { z } from "zod";

import {
  authorizedPilotInput,
  waitForFixture,
} from "../../slice-1/application.ts";
import { inspect, overview, waitTeamAdmission } from "./inspection-support.ts";
import { matchingTeamEvent } from "./team-queue-support.ts";
import {
  controlQueue,
  event,
  fixture,
  observed,
  primaryDecision,
  queue,
  send,
  teamRoles,
} from "./team-support.ts";
import {
  createConversation,
  sendTurn,
  startedWork,
  stopWork,
  waitWorkReport,
} from "./web-team-support.ts";

export const admitReference = async (
  agentId: string,
  key: string,
  eventId: string,
  thread: string
) => {
  const before = await observed();
  const previous = new Set(before.slack.messages.map((item) => item.ts));
  const input = event(
    eventId,
    `PERSISTENT_AGENT_FIXTURE status ${key}. Remember this thread reference.`,
    thread,
    thread
  );
  await send(input);
  const saved = await primaryDecision(eventId);
  await waitForFixture(observed, (value) =>
    value.slack.messages.some(
      (item) =>
        !previous.has(item.ts) &&
        item.threadTs === thread &&
        item.text ===
          "No unique permitted work result matches this task. No action was taken."
    )
  );
  assert.ok(
    saved.decision.targets.some((target) => target.agentId === agentId)
  );
  return { input, saved, key, thread, agentId };
};
export const subscribeLiveWork = async (
  reference: Awaited<ReturnType<typeof admitReference>>
) => {
  const { route, conversation } = await createConversation(reference.agentId);
  const before = await observed();
  await fixture.controls({
    models: { [teamRoles.worker]: { hold: true, delayMs: 0 } },
  });
  const goal = `PERSISTENT_AGENT_FIXTURE ${reference.key}. Review the task's correctness and implementation constraints.`;
  const started = await sendTurn(route, goal);
  const target = startedWork(started.view.snapshot, goal);
  assert.ok(target);
  assert.ok(
    target.work.status.kind === "accepted" ||
      target.work.status.kind === "running",
    "Subscribed Work must have an active reservation before waiting for its workers."
  );
  const heldWorkers = await waitForFixture(
    observed,
    (value) => value.held >= before.held + 2
  );
  const subscribed = await sendTurn(
    route,
    `PERSISTENT_AGENT_FIXTURE subscribe ${reference.key}. Follow the admitted Slack thread.`
  );
  const calls = subscribed.tools.filter(
    (tool) => tool.toolName === "subscribe_work"
  );
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call?.state === "succeeded");
  const args = z
    .object({ workId: z.string(), eventId: z.string() })
    .parse(call.arguments);
  assert.equal(args.workId, target.key.workId);
  const events = await inspect(route, { kind: "events" });
  assert.ok(events.kind === "events");
  assert.ok(
    events.events.some(
      (item) => item.id === args.eventId && item.source === "slack"
    )
  );
  const detail = await inspect(route, {
    kind: "team",
    workId: target.key.workId,
  });
  assert.ok(detail.kind === "team");
  assert.equal(detail.work.subscriptions.length, 1);
  assert.equal(detail.work.subscriptions[0]?.rootTimestamp, reference.thread);
  return {
    reference,
    route,
    conversation,
    target,
    started,
    heldWorkers,
    subscribed,
    args,
    detail,
  };
};
export type LiveSubscription = Awaited<ReturnType<typeof subscribeLiveWork>>;
export const queuedTeamEvent = async (
  live: LiveSubscription,
  input: ReturnType<typeof event>
) => {
  await controlQueue("pause", "cerebro-team-commands");
  await send(input);
  const pending = await waitForFixture(
    () => queue("peek", "cerebro-team-commands", 50),
    (value) =>
      matchingTeamEvent(value, live.target, input.event_id) !== undefined
  );
  const command = matchingTeamEvent(pending, live.target, input.event_id);
  assert.ok(command?.event && command.command.kind === "input");
  const text = `External event ${command.event.id}. Use return_event if it is unrelated to this work.\n${command.command.text}`;
  const wire = authorizedPilotInput(text);
  const digest = createHash("sha256").update(wire).digest("hex");
  const beforeAdmission = await inspect(live.route, {
    kind: "tasks",
    workId: live.target.key.workId,
    role: 0,
  });
  assert.ok(beforeAdmission.kind === "tasks");
  await fixture.controls({
    models: {
      [teamRoles.lead]: { hold: true, delayMs: 500 },
      [teamRoles.worker]: { hold: true, delayMs: 0 },
    },
  });
  await controlQueue("resume", "cerebro-team-commands");
  const admission = await waitTeamAdmission(
    live.route,
    live.target.key.workId,
    beforeAdmission
  );
  await fixture.controls({
    models: {
      [teamRoles.lead]: { hold: true, delayMs: 500 },
      [teamRoles.worker]: { hold: false, delayMs: 0 },
    },
  });
  const held = await waitForFixture(
    observed,
    (value) =>
      value.model.some(
        (call) =>
          call.role === teamRoles.lead &&
          call.completedAt === undefined &&
          call.messageTextDigests.includes(digest)
      ),
    60_000
  );
  return { pending, command, wire, digest, admission, held };
};
export const stopSubscriptionWork = async (live: LiveSubscription) => {
  await controlQueue("pause");
  await stopWork(live.route, live.target.key.workId);
  await fixture.controls({ models: {}, release: true });
  const waiting = await waitWorkReport("cerebro-team-reports", live.target);
  await controlQueue("resume");
  await waitForFixture(
    () => overview(live.route),
    (value) =>
      value.work.some(
        (work) =>
          work.workId === live.target.key.workId && !work.reservationHeld
      ),
    60_000
  );
  return waiting;
};
