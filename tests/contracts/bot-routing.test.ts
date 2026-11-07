import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import {
  BotEventSchema,
  botEventId,
} from "../../packages/contracts/src/bot-events.ts";
import { normalizeEventAdmission } from "../../packages/contracts/src/bot-routing.ts";
import {
  normalizeTeamCommand,
  normalizeTeamReport,
  TeamEventCommandSchema,
  teamReportReceiptMatches,
} from "../../packages/contracts/src/team-events.ts";
import { digestToolArguments } from "../../packages/contracts/src/tools.ts";
import { WorkAdmissionSchema } from "../../packages/contracts/src/work.ts";

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
const event = async () => {
  const source = { kind: "web" as const, operationId: "operation" };
  return Schema.decodeUnknownSync(BotEventSchema)({
    version: 1,
    id: await botEventId(
      work.sourceEventAddress,
      Schema.decodeUnknownSync(BotEventSchema.fields.source)(source)
    ),
    coordinator: work.sourceEventAddress,
    ownerPrincipalId: work.key.ownerPrincipalId,
    source,
    replyTo: { kind: "web", address: work.sourceEventAddress },
    content: { text: "Apply a new task constraint.", reference: null },
    dependencies: { sourceIds: [], toolIds: [] },
  });
};

test("strict event admission preserves literal v1 and hashes explicit controls", async () => {
  const original = await event();
  assert.deepEqual(normalizeEventAdmission(original).wire, original);
  const input = {
    version: 2,
    kind: "event-admission",
    event: original,
    routing: { kind: "control", workId: work.key.workId, action: "update" },
  };
  const admitted = normalizeEventAdmission(input);
  const changed = normalizeEventAdmission({
    ...input,
    routing: { ...input.routing, action: "cancel" },
  });
  assert.notEqual(
    await digestToolArguments(admitted.wire),
    await digestToolArguments(changed.wire)
  );
  assert.throws(() =>
    normalizeEventAdmission({
      ...input,
      routing: { ...input.routing, cellName: "untrusted" },
    })
  );
  assert.throws(() =>
    normalizeEventAdmission({
      ...input,
      routing: { kind: "local-control", action: "status" },
    })
  );
});

test("new Team command digests include event source and reply metadata", async () => {
  const original = await event();
  const command = {
    id: "event-command",
    kind: "input",
    work,
    text: original.content.text,
    contentDependencies: original.dependencies,
  };
  const wire = Schema.decodeUnknownSync(TeamEventCommandSchema)({
    version: 2,
    kind: "event-command",
    command,
    event: {
      id: original.id,
      digest: "source-digest",
      source: original.source,
      replyTo: original.replyTo,
    },
  });
  const parsed = normalizeTeamCommand(wire);
  assert.equal(parsed.command.id, "event-command");
  assert.deepEqual(parsed.event, wire.event);
  assert.notEqual(
    await digestToolArguments(parsed.wire),
    await digestToolArguments({
      ...wire,
      event: { ...wire.event, replyTo: null },
    })
  );
  assert.throws(() =>
    normalizeTeamCommand({ ...wire, command: { ...command, kind: "cancel" } })
  );
  assert.throws(() => normalizeTeamCommand({ ...wire, unexpected: true }));
});

test("report and nonterminal return envelopes use exact owner, source, path and receipt correlation", async () => {
  const original = await event();
  const returned = normalizeTeamReport({
    version: 2,
    kind: "event-return",
    work,
    eventId: original.id,
    eventDigest: "source-digest",
  });
  assert.equal(returned.path, "/team-event-return");
  assert.deepEqual(returned.key, work.key);
  assert.deepEqual(returned.sourceEventAddress, work.sourceEventAddress);
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
  assert.throws(() =>
    normalizeTeamReport({ ...returned.wire, reason: "Private text." })
  );
  const report = normalizeTeamReport({
    version: 2,
    sourceEventAddress: work.sourceEventAddress,
    report: {
      id: "report",
      kind: "completed",
      key: work.key,
      text: "A useful answer.",
      contentDependencies: work.contentDependencies,
    },
  });
  assert.equal(report.path, "/team-report");
  assert.equal(
    teamReportReceiptMatches(report, {
      reportId: "report",
      key: work.key,
      accepted: false,
    }),
    true
  );
  assert.throws(() =>
    teamReportReceiptMatches(report, {
      eventId: original.id,
      key: work.key,
      accepted: true,
    })
  );
});
