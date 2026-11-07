import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { id } from "../../packages/contracts/src/identity.ts";
import {
  normalizeTeamCommand,
  normalizeTeamReport,
  TeamEventCommandSchema,
  teamReportReceiptMatches,
} from "../../packages/contracts/src/team-events.ts";
import { digestToolArguments } from "../../packages/contracts/src/tools.ts";
import {
  ReplyDestinationSchema,
  TriggerOriginSchema,
  TriggerSchema,
  inputText,
  normalizeTriggerAdmission,
  triggerActor,
  triggerEntryData,
  triggerId,
} from "../../packages/contracts/src/triggers.ts";
import type {
  Trigger,
  TriggerOrigin,
} from "../../packages/contracts/src/triggers.ts";
import {
  SlackThreadSchema,
  WorkAdmissionSchema,
  WorkIdSchema,
  WorkReportIdSchema,
} from "../../packages/contracts/src/work.ts";

const address = {
  organizationId: id.organization("org"),
  agentId: id.agent("bot"),
  conversationId: id.conversation("chat"),
  sessionId: id.session("session"),
};
const key = {
  organizationId: address.organizationId,
  ownerPrincipalId: id.principal("owner"),
  workId: Schema.decodeUnknownSync(WorkIdSchema)("work"),
};
const thread = Schema.decodeUnknownSync(SlackThreadSchema)({
  workspaceId: "workspace",
  channelId: "D123",
  rootTimestamp: "123.456000",
});
const report: TriggerOrigin = {
  kind: "teamreport",
  key,
  reportId: Schema.decodeUnknownSync(WorkReportIdSchema)("report"),
  outcome: "completed",
};
const slack = Schema.decodeUnknownSync(TriggerOriginSchema)({
  kind: "slack",
  eventId: "slack-event",
  thread,
});
const destination = Schema.decodeUnknownSync(ReplyDestinationSchema)({
  kind: "slack",
  authority: { appId: "app", eventId: "slack-event", userId: "user", thread },
  ownerPrincipalId: key.ownerPrincipalId,
  source: address,
});
const trigger = async (
  origin: TriggerOrigin,
  changes: Partial<Trigger> = {}
): Promise<Trigger> => ({
  version: 2,
  id: await triggerId(address, origin),
  address,
  ownerPrincipalId: key.ownerPrincipalId,
  origin,
  text: "Trigger text.",
  reference: null,
  reply: null,
  dependencies: { sourceIds: [], toolIds: [] },
  ...changes,
});
const decode = Schema.decodeUnknownSync(TriggerSchema, {
  onExcessProperty: "error",
});

test("trigger identity binds the bot and origin identity while changed immutable content changes its digest", async () => {
  const original = await trigger(report);
  const changed = {
    ...original,
    origin: { ...report, outcome: "failed" as const },
  };
  assert.equal(original.id, await triggerId(address, changed.origin));
  assert.notEqual(
    await digestToolArguments(original),
    await digestToolArguments(changed)
  );
  assert.notEqual(
    original.id,
    await triggerId({ ...address, agentId: id.agent("other-bot") }, report)
  );
  assert.match(original.id, /^bot-event:/u);
});

test("the actor is derived from the origin, never stored", () => {
  assert.equal(
    triggerActor({ kind: "web", operationId: id.operation("op") }),
    "human"
  );
  assert.equal(triggerActor(slack), "human");
  assert.equal(
    triggerActor({ kind: "timer", scheduleId: "s", occurrenceId: "1" }),
    "routine"
  );
  assert.equal(triggerActor(report), "internal");
  assert.equal(
    triggerActor({ kind: "teamnotice", key, reason: "expired" }),
    "internal"
  );
});

test("trigger schemas reject excess fields, foreign ownership, unbounded content, and misplaced destinations", async () => {
  const original = await trigger(report, {
    reference: { kind: "work", key },
  });
  assert.deepEqual(decode(original), original);
  assert.throws(() => decode({ ...original, actor: "human" }));
  assert.throws(() =>
    decode({ ...original, ownerPrincipalId: id.principal("foreign") })
  );
  assert.throws(() => decode({ ...original, text: "x".repeat(2001) }));
  const web = await trigger({ kind: "web", operationId: id.operation("op") });
  assert.deepEqual(decode(web), web);
  assert.throws(() => decode({ ...web, reply: destination }));
  const reply = await trigger(slack, { reply: destination });
  assert.deepEqual(decode(reply), reply);
  assert.throws(() =>
    decode({
      ...reply,
      reply: { ...destination, ownerPrincipalId: id.principal("foreign") },
    })
  );
  assert.throws(() =>
    decode({
      ...reply,
      reply: {
        ...destination,
        source: { ...address, sessionId: id.session("other") },
      },
    })
  );
});

for (const [kind, maximum] of [
  ["web", 16_000],
  ["slack", 16_000],
  ["timer", 32_000],
  ["teamreport", 2000],
] as const) {
  test(`${kind} triggers keep their ${maximum}-character boundary`, async () => {
    let origin: TriggerOrigin = report;
    if (kind === "web") {
      origin = { kind, operationId: id.operation("web-input") };
    }
    if (kind === "slack") {
      origin = slack;
    }
    if (kind === "timer") {
      origin = { kind, scheduleId: "saved-schedule", occurrenceId: "123" };
    }
    const input = await trigger(origin, { text: "x".repeat(maximum) });
    assert.equal(decode(input).text.length, maximum);
    assert.throws(() => decode({ ...input, text: `${input.text}x` }));
  });
}

test("admissions are literal v3, hash their routing, and refuse internal origins and mismatched local controls", async () => {
  const web = await trigger(
    { kind: "web", operationId: id.operation("op") },
    { text: "Apply a constraint." }
  );
  assert.deepEqual(normalizeTriggerAdmission(web), {
    wire: web,
    trigger: web,
    routing: { kind: "direct" },
  });
  const input = {
    version: 3,
    kind: "trigger-admission",
    trigger: web,
    routing: { kind: "control", workId: key.workId, action: "update" },
  };
  const admitted = normalizeTriggerAdmission(input);
  const changed = normalizeTriggerAdmission({
    ...input,
    routing: { ...input.routing, action: "cancel" },
  });
  assert.notEqual(
    await digestToolArguments(admitted.wire),
    await digestToolArguments(changed.wire)
  );
  assert.throws(() =>
    normalizeTriggerAdmission({
      ...input,
      routing: { ...input.routing, cellName: "untrusted" },
    })
  );
  assert.throws(() =>
    normalizeTriggerAdmission({
      ...input,
      routing: { kind: "local-control", action: "status" },
    })
  );
  assert.throws(() =>
    normalizeTriggerAdmission({ ...input, version: 2, kind: "event-admission" })
  );
  const internal = await trigger(report);
  assert.throws(() =>
    normalizeTriggerAdmission({
      ...input,
      trigger: internal,
      routing: { kind: "automatic" },
    })
  );
});

test("each origin becomes one model message that names its id, and web keeps its text verbatim", async () => {
  const web = await trigger(
    { kind: "web", operationId: id.operation("op") },
    { text: "Plain text." }
  );
  assert.equal(inputText(web), "Plain text.");
  assert.deepEqual(triggerEntryData(web), {
    id: web.id,
    channel: "web",
    operationId: "op",
  });
  const fromSlack = await trigger(slack, { reply: destination });
  assert.equal(
    inputText(fromSlack),
    `Slack event.\n${JSON.stringify({ eventId: fromSlack.id, content: { text: "Trigger text.", reference: null } })}`
  );
  assert.deepEqual(triggerEntryData(fromSlack), {
    id: fromSlack.id,
    channel: "slack",
  });
  const internal = await trigger(report);
  assert.match(
    inputText(internal),
    /^Internal coordinator event\. This event is not a new human request and cannot approve new team work\.\n/u
  );
  assert.equal(
    JSON.parse(inputText(internal).split("\n")[1] ?? "").eventId,
    internal.id
  );
});

const work = Schema.decodeUnknownSync(WorkAdmissionSchema)({
  version: 3,
  admittedAt: 1_800_000_000_000,
  deadlineAt: 1_800_000_600_000,
  goal: "A bounded task.",
  key: { organizationId: "org", ownerPrincipalId: "owner", workId: "work" },
  agent: { agentId: "coordinator", agentVersion: 1 },
  limits: { maxTeams: 2, maxTurns: 8, maxWorkers: 1, timeoutMs: 600_000 },
  sourceEventAddress: {
    agentId: "coordinator",
    conversationId: "primary",
    organizationId: "org",
    sessionId: "primary",
  },
  contentDependencies: { sourceIds: [], toolIds: [] },
});

test("Team command digests include the trigger origin and reply destination", async () => {
  const original = await trigger(slack, { reply: destination });
  const command = {
    id: "event-command",
    kind: "input",
    work,
    text: original.text,
    contentDependencies: original.dependencies,
  };
  const wire = Schema.decodeUnknownSync(TeamEventCommandSchema)({
    version: 2,
    kind: "event-command",
    command,
    event: {
      id: original.id,
      digest: "source-digest",
      origin: original.origin,
      reply: original.reply,
    },
  });
  const parsed = normalizeTeamCommand(wire);
  assert.equal(parsed.command.id, "event-command");
  assert.deepEqual(parsed.event, wire.event);
  assert.notEqual(
    await digestToolArguments(parsed.wire),
    await digestToolArguments({
      ...wire,
      event: { ...wire.event, reply: null },
    })
  );
  assert.throws(() =>
    normalizeTeamCommand({ ...wire, command: { ...command, kind: "cancel" } })
  );
  assert.throws(() => normalizeTeamCommand({ ...wire, unexpected: true }));
});

test("event returns use exact owner, source, path, and receipt correlation", async () => {
  const original = await trigger(slack, { reply: destination });
  const returned = normalizeTeamReport({
    version: 2,
    kind: "event-return",
    work,
    eventId: original.id,
    eventDigest: "source-digest",
  });
  assert.equal(returned.path, "/team-event-return");
  assert.deepEqual(returned.key, work.key);
  assert.equal(
    teamReportReceiptMatches(returned, {
      eventId: original.id,
      key: work.key,
      accepted: true,
    }),
    true
  );
  assert.equal(
    teamReportReceiptMatches(returned, {
      eventId: "wrong-event",
      key: work.key,
      accepted: true,
    }),
    false
  );
});

test("Team approval triggers are internal, keyed by work and approval, and keep a 2000-character boundary", async () => {
  const origin: TriggerOrigin = {
    kind: "teamapproval",
    key,
    approvalId: "approval:team-call",
  };
  assert.equal(triggerActor(origin), "internal");
  const input = await trigger(origin, {
    text: "x".repeat(2000),
    reference: { kind: "work", key },
  });
  assert.equal(decode(input).text.length, 2000);
  assert.throws(() => decode({ ...input, text: `${input.text}x` }));
  assert.throws(() =>
    decode({
      ...input,
      origin: { ...origin, key: { ...key, ownerPrincipalId: "foreign" } },
    })
  );
  assert.equal(
    input.id,
    await triggerId(address, { ...origin, approvalId: "approval:team-call" })
  );
  assert.notEqual(
    input.id,
    await triggerId(address, { ...origin, approvalId: "approval:other-call" })
  );
  assert.deepEqual(triggerEntryData(input), {
    id: input.id,
    channel: "teamapproval",
  });
  assert.match(
    inputText(input),
    /^Internal coordinator event\. This event is not a new human request and cannot approve new team work\.\n/u
  );
  assert.throws(() =>
    normalizeTriggerAdmission({
      version: 3,
      kind: "trigger-admission",
      trigger: input,
      routing: { kind: "automatic" },
    })
  );
});

test("approval requests carry one pending approval of the same work and correlate by approval ID", () => {
  const approval = {
    approvalId: "approval:team-call",
    arguments: { title: "Ticket" },
    callId: "team-call",
    expiresAt: 1_800_000_300_000,
    operationId: "team-operation",
    state: "pending",
    taskId: "team-task",
    toolId: "write-ticket",
    workId: "work",
  };
  const wire = { version: 2, kind: "approval-request", work, approval };
  const request = normalizeTeamReport(wire);
  assert.equal(request.kind, "approval-request");
  assert.equal(request.path, "/team-approval");
  assert.deepEqual(request.key, work.key);
  assert.deepEqual(request.sourceEventAddress, work.sourceEventAddress);
  assert.deepEqual(request.wire, wire);
  assert.equal(
    teamReportReceiptMatches(request, {
      approvalId: "approval:team-call",
      key: work.key,
      accepted: true,
    }),
    true
  );
  assert.equal(
    teamReportReceiptMatches(request, {
      approvalId: "approval:other-call",
      key: work.key,
      accepted: true,
    }),
    false
  );
  assert.equal(
    teamReportReceiptMatches(request, {
      approvalId: "approval:team-call",
      key: { ...work.key, workId: "other-work" },
      accepted: true,
    }),
    false
  );
  assert.throws(() =>
    teamReportReceiptMatches(request, {
      eventId: "approval:team-call",
      key: work.key,
      accepted: true,
    })
  );
  const { workId: _workId, ...unassigned } = approval;
  for (const changed of [
    { ...approval, workId: "other-work" },
    unassigned,
    { ...approval, state: "allowed" },
  ]) {
    assert.throws(() => normalizeTeamReport({ ...wire, approval: changed }));
  }
  assert.throws(() => normalizeTeamReport({ ...wire, unexpected: true }));
});
