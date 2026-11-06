import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { Schema } from "effect";
import { z } from "zod";

import {
  BotEventSourceSchema,
  botEventId,
} from "../../../packages/contracts/src/bot-events.ts";
import type { ChatSnapshot } from "../../../packages/contracts/src/session-service.ts";
import { toSlackText } from "../../../packages/contracts/src/slack-text.ts";
import { canonicalToolArguments } from "../../../packages/contracts/src/tools.ts";
import { WorkKeySchema } from "../../../packages/contracts/src/work.ts";
import type { TeamReportDelivery } from "../../../packages/contracts/src/work.ts";
import { conciseSlackText } from "../../../packages/runtime/src/coordinator-replies.ts";
import {
  authorizedPilotInput,
  waitForFixture,
} from "../../slice-1/application.ts";
import { inspect } from "./inspection-support.ts";
import { queueBodies, reportEvent } from "./team-queue-support.ts";
import type { event, Observation, snapshot } from "./team-support.ts";
import {
  metadata,
  observed,
  primaryDecision,
  send,
  slack,
  wireModels,
} from "./team-support.ts";

export const slackInputEvidence = async (input: {
  admitted: Awaited<ReturnType<typeof snapshot>>;
  before: Observation;
  physical: Observation;
  requestCount: 1 | 2;
  answer: string;
}) => {
  const { admitted, before, physical } = input;
  const { decision } = admitted.saved;
  const source = Schema.decodeUnknownSync(BotEventSourceSchema)({
    kind: "slack",
    eventId: decision.authority.eventId,
    thread: decision.authority.thread,
  });
  const id = await botEventId(admitted.target, source);
  const text = `Slack event.\n${JSON.stringify({ eventId: id, content: { text: decision.text, reference: null } })}`;
  const wire = authorizedPilotInput(text);
  const digest = createHash("sha256").update(wire).digest("hex");
  const requests = physical.model
    .slice(before.model.length)
    .filter((call) => call.model === wireModels.coordinator);
  assert.equal(requests.length, input.requestCount);
  assert.ok(
    requests.every(
      (call) =>
        call.completedAt !== undefined &&
        call.messageTextDigests.includes(digest)
    )
  );
  assert.equal(new Set(requests.map((call) => call.operationId)).size, 1);
  const events = await waitForFixture(
    () =>
      inspect(
        `/api/product/conversations/${encodeURIComponent(admitted.conversationId)}`,
        { kind: "events" }
      ),
    (value) =>
      value.kind === "events" &&
      value.events.some(
        (item) =>
          item.id === id &&
          item.admission === "settled" &&
          item.reply?.state === "sent"
      )
  );
  assert.ok(events.kind === "events");
  assert.deepEqual(events.address, admitted.target);
  const saved = events.events.filter((item) => item.id === id);
  assert.equal(saved.length, 1);
  const [record] = saved;
  assert.ok(record?.reply);
  assert.equal(record.source, "slack");
  assert.equal(record.route, "coordinator");
  assert.equal(record.outcome, "done");
  const answers = admitted.snapshot.messages.filter(
    (message) => message.entryId === record.reply?.answerEntryId
  );
  assert.equal(answers.length, 1);
  const [answer] = answers;
  assert.ok(answer);
  assert.equal(answer.role, "assistant");
  assert.equal(answer.state, "complete");
  assert.equal(answer.text, input.answer);
  const replies = physical.slack.messages.filter(
    (message) =>
      message.ts === record.reply?.timestamp &&
      message.channel === decision.authority.thread.channelId &&
      message.threadTs === decision.authority.thread.rootTimestamp &&
      message.text === input.answer
  );
  assert.equal(replies.length, 1);
  return { id, text, wire, digest, requests, events, record, answer, replies };
};

export const slackWork = async (
  input: ReturnType<typeof event>,
  agentId: string,
  caseKey: string
) => {
  await send(input);
  const saved = await primaryDecision(input.event_id);
  const targets = saved.decision.targets.filter(
    (target) => target.agentId === agentId
  );
  assert.equal(targets.length, 1);
  const [sourceEventAddress] = targets;
  assert.ok(sourceEventAddress);
  const physical = await waitForFixture(
    observed,
    (value) =>
      value.slack.messages.some(
        (message) =>
          message.channel === input.event.channel &&
          message.threadTs === (input.event.thread_ts ?? input.event.ts) &&
          message.text.endsWith(` for ${caseKey}.`) &&
          /^Work \S+ is (?:accepted|queued) for /u.test(message.text)
      ),
    60_000
  );
  const replies = physical.slack.messages.filter(
    (message) =>
      message.channel === input.event.channel &&
      message.threadTs === (input.event.thread_ts ?? input.event.ts) &&
      message.text.endsWith(` for ${caseKey}.`)
  );
  assert.equal(replies.length, 1);
  const [acknowledgement] = replies;
  assert.ok(acknowledgement);
  const match = /^Work (?<workId>\S+) is (?<status>accepted|queued) for /u.exec(
    acknowledgement.text
  );
  assert.ok(match?.groups);
  const key = Schema.decodeUnknownSync(WorkKeySchema)({
    organizationId: sourceEventAddress.organizationId,
    ownerPrincipalId: saved.decision.ownerPrincipalId,
    workId: match.groups.workId,
  });
  return {
    key,
    sourceEventAddress,
    route: `/api/product/conversations/${encodeURIComponent(sourceEventAddress.conversationId)}`,
    saved,
    acknowledgement,
    physical,
    status: match.groups.status,
  };
};
export const slackAnswer = (text: string): string =>
  conciseSlackText(toSlackText(text));
export const slackReportEvidence = async (input: {
  origin: Awaited<ReturnType<typeof slackWork>>;
  delivery: TeamReportDelivery;
  snapshot: ChatSnapshot;
  before: Observation;
  physical: Observation;
}) => {
  const { origin, delivery, before, physical } = input;
  assert.deepEqual(delivery.sourceEventAddress, origin.sourceEventAddress);
  assert.deepEqual(delivery.report.key, origin.key);
  const event = await reportEvent(delivery);
  const text = `Team report received. ${event.content.text}`;
  const postedText = slackAnswer(text);
  const events = await waitForFixture(
    () => inspect(origin.route, { kind: "events" }),
    (value) =>
      value.kind === "events" &&
      value.events.some(
        (item) =>
          item.id === event.id &&
          item.admission === "settled" &&
          item.reply?.state === "sent"
      )
  );
  assert.ok(events.kind === "events");
  assert.deepEqual(events.address, origin.sourceEventAddress);
  const saved = events.events.filter((item) => item.id === event.id);
  assert.equal(saved.length, 1);
  const [record] = saved;
  assert.ok(record?.reply);
  assert.equal(record.source, "teamreport");
  assert.equal(record.route, "coordinator");
  assert.equal(record.outcome, "done");
  const answers = input.snapshot.messages.filter(
    (message) => message.entryId === record.reply?.answerEntryId
  );
  assert.equal(answers.length, 1);
  const [answer] = answers;
  assert.ok(answer);
  assert.equal(answer.role, "assistant");
  assert.equal(answer.state, "complete");
  assert.equal(answer.text, text);
  const { thread } = origin.saved.decision.authority;
  const posts = physical.slack.calls
    .slice(before.slack.calls.length)
    .filter((call) => call.method === "chat.postMessage");
  assert.deepEqual(
    posts.map((call) => ({
      channel: call.request.channel,
      thread: call.request.thread_ts,
      text: call.request.text,
      status: call.status,
    })),
    [
      {
        channel: thread.channelId,
        thread: thread.rootTimestamp,
        text: postedText,
        status: 200,
      },
    ]
  );
  const [post] = posts;
  assert.ok(post);
  const response = z
    .object({ ok: z.literal(true), ts: z.string() })
    .parse(post.response);
  assert.equal(response.ts, record.reply.timestamp);
  assert.equal(
    physical.slack.messages.filter(
      (message) =>
        message.ts === response.ts &&
        message.channel === thread.channelId &&
        message.threadTs === thread.rootTimestamp &&
        message.text === postedText
    ).length,
    1
  );
  return { event, text, postedText, events, record, answer, posts };
};
export const matchingSlackDelivery = (
  value: unknown,
  input: ReturnType<typeof event>,
  agentId: string
) =>
  queueBodies(value).find((body) => {
    const parsed = z
      .object({
        version: z.literal(1),
        agentId: z.string(),
        appId: z.string(),
        organizationId: z.string(),
        workspaceId: z.string(),
        eventId: z.string(),
        event: z.unknown(),
      })
      .parse(body);
    return (
      parsed.agentId === agentId &&
      parsed.appId === slack.appId &&
      parsed.organizationId === metadata.agent.organizationId &&
      parsed.workspaceId === slack.workspaceId &&
      parsed.eventId === input.event_id &&
      canonicalToolArguments(parsed.event) ===
        canonicalToolArguments(input.event)
    );
  });
