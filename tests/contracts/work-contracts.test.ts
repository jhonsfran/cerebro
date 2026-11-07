import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Schema } from "effect";

import {
  TeamCommandReceiptSchema,
  TeamCommandSchema,
  TeamReportDeliverySchema,
  WorkAdmissionSchema,
  WorkReportSchema,
  WorkStatusSchema,
  transitionWorkStatus,
  workCellName,
  workStartOperationId,
} from "../../packages/contracts/src/work.ts";

const admission = () => ({
  version: 2,
  admittedAt: 1_800_000_000_000,
  contentDependencies: { sourceIds: [], toolIds: [] },
  deadlineAt: 1_800_000_600_000,
  goal: "Compare the two deployment reports.",
  key: {
    organizationId: "org-A",
    ownerPrincipalId: "owner-A",
    workId: "work-A",
  },
  lead: { agentId: "lead-A", agentVersion: 4 },
  limits: { maxTeams: 2, maxTurns: 8, maxWorkers: 2, timeoutMs: 600_000 },
  sourceEventAddress: {
    agentId: "coordinator-A",
    conversationId: "conversation-A",
    organizationId: "org-A",
    sessionId: "session-A",
  },
  worker: { agentId: "worker-A", agentVersion: 7 },
});
const threadMetadata = {
  channelId: "D123",
  rootTimestamp: "1800000000.000001",
  workspaceId: "T123",
};

test("version 2 work and reports use an exact canonical source without Slack", () => {
  const work = admission();
  const decode = Schema.decodeUnknownSync(WorkAdmissionSchema, {
    onExcessProperty: "error",
  });
  assert.deepEqual(decode(work), work);
  const report = {
    contentDependencies: { sourceIds: [], toolIds: [] },
    id: "report-A",
    key: work.key,
    kind: "completed",
    text: "Result.",
  };
  const delivery = {
    version: 2,
    report,
    sourceEventAddress: work.sourceEventAddress,
  };
  const decodeReport = Schema.decodeUnknownSync(TeamReportDeliverySchema, {
    onExcessProperty: "error",
  });
  assert.deepEqual(decodeReport(delivery), delivery);
  for (const changed of [
    { ...work, version: 3 },
    { ...work, version: undefined },
    { ...work, threadMetadata },
    { ...work, unexpected: true },
  ]) {
    assert.throws(() => decode(changed));
  }
  for (const changed of [
    { ...delivery, version: 3 },
    { ...delivery, version: undefined },
    { ...delivery, threadMetadata },
    { ...delivery, unexpected: true },
    {
      report,
      sourceEventAddress: work.sourceEventAddress,
      threadMetadata: { channelId: "D123" },
    },
  ]) {
    assert.throws(() => decodeReport(changed));
  }
});

test("command JSON and stringify digests retain their field order", () => {
  const work = admission();
  const cases = [
    {
      command: { id: "start-A", kind: "start", work },
      digest:
        "09a56a063655aaf8eae566319dce0742ca995a0b3e5874562913fc98c9615067",
    },
    {
      command: {
        id: "input-A",
        kind: "input",
        contentDependencies: { sourceIds: [], toolIds: [] },
        text: "Include the outage.",
        work,
      },
      digest:
        "9c0e6ed33ae4a0688fe22bd533fb0e5697f10d61a5418987498c487e6e7d0dba",
    },
    {
      command: { id: "cancel-A", kind: "cancel", work },
      digest:
        "455a4f541ed80559b594c23c366aaa8ec347e9eb394f7c0accfe083867235068",
    },
  ];
  for (const { command, digest } of cases) {
    const json = JSON.stringify(command);
    const saved = Schema.decodeUnknownSync(TeamCommandSchema, {
      onExcessProperty: "error",
    })(JSON.parse(json));
    assert.equal(JSON.stringify(saved), json);
    assert.equal(
      createHash("sha256").update(JSON.stringify(saved)).digest("hex"),
      digest
    );
  }
});

test("work admission preserves public source identity and published role pins", () => {
  const value = admission();
  const serialized = JSON.stringify(value);
  assert.deepEqual(
    Schema.decodeUnknownSync(WorkAdmissionSchema)(JSON.parse(serialized)),
    value
  );
  for (const changed of [
    { key: { ...value.key, organizationId: "org-B" } },
    { key: { ...value.key, ownerPrincipalId: " owner-A" } },
    { key: { ...value.key, workId: "" } },
    { lead: { ...value.lead, agentVersion: 0 } },
    { worker: { ...value.worker, agentVersion: 1.5 } },
    { sourceEventAddress: { ...value.sourceEventAddress, sessionId: "" } },
    { admittedAt: Number.POSITIVE_INFINITY },
    { deadlineAt: value.admittedAt },
    { deadlineAt: value.deadlineAt + 1 },
    { limits: { ...value.limits, maxWorkers: 3 } },
    { contentDependencies: undefined },
    { contentDependencies: { sourceIds: [" source-A"], toolIds: [] } },
    {
      contentDependencies: {
        sourceIds: Array.from({ length: 513 }, () => "source-A"),
        toolIds: [],
      },
    },
    { goal: "x".repeat(16_001) },
  ]) {
    assert.throws(() =>
      Schema.decodeUnknownSync(WorkAdmissionSchema)({ ...value, ...changed })
    );
  }
});

test("every team command carries the immutable admission for unordered delivery", () => {
  const work = admission();
  for (const command of [
    { id: "start-A", kind: "start", work },
    {
      id: "input-A",
      kind: "input",
      text: "Include the outage.",
      contentDependencies: { sourceIds: [], toolIds: [] },
      work,
    },
    { id: "cancel-A", kind: "cancel", work },
  ]) {
    const serialized = JSON.stringify(command);
    assert.deepEqual(
      Schema.decodeUnknownSync(TeamCommandSchema)(JSON.parse(serialized)),
      command
    );
  }
  for (const command of [
    { id: "input-A", kind: "input", text: "Include the outage." },
    { id: "input-A", kind: "input", work },
    { id: "input-A", kind: "input", text: "Private update.", work },
    { id: "cancel-A", kind: "cancel", text: "Unexpected", work },
    { id: "", kind: "start", work },
    { id: "unknown-A", kind: "restart", work },
  ]) {
    assert.throws(() =>
      Schema.decodeUnknownSync(TeamCommandSchema, {
        onExcessProperty: "error",
      })(command)
    );
  }
});

test("business work and start input identities are stable and tenant scoped", () => {
  const { key } = Schema.decodeUnknownSync(WorkAdmissionSchema)(admission());
  assert.equal(workCellName(key), '["team-v1","org-A","owner-A","work-A"]');
  assert.equal(
    workStartOperationId(key),
    '["work-start-v1","org-A","owner-A","work-A"]'
  );
  for (const changed of [
    { ...admission().key, organizationId: "org-B" },
    { ...admission().key, ownerPrincipalId: "owner-B" },
    { ...admission().key, workId: "work-B" },
  ]) {
    const other = Schema.decodeUnknownSync(WorkAdmissionSchema)({
      ...admission(),
      key: changed,
      sourceEventAddress: {
        ...admission().sourceEventAddress,
        organizationId: changed.organizationId,
      },
    });
    assert.notEqual(workCellName(other.key), workCellName(key));
    assert.notEqual(workStartOperationId(other.key), workStartOperationId(key));
  }
});

test("cancel and terminal outcomes cannot be replaced by delayed execution", () => {
  assert.deepEqual(
    Schema.decodeUnknownSync(WorkStatusSchema)({ kind: "queued" }),
    { kind: "queued" }
  );
  assert.deepEqual(
    transitionWorkStatus({ kind: "queued" }, { kind: "accepted" }),
    { kind: "accepted" }
  );
  assert.deepEqual(
    transitionWorkStatus({ kind: "accepted" }, { kind: "queued" }),
    { kind: "accepted" }
  );
  const cancelled = Schema.decodeUnknownSync(WorkStatusSchema)({
    commandId: "cancel-A",
    kind: "cancelled",
  });
  const completed = Schema.decodeUnknownSync(WorkStatusSchema)({
    kind: "completed",
    reportId: "report-A",
  });
  const failed = Schema.decodeUnknownSync(WorkStatusSchema)({
    kind: "failed",
    reason: "Role access was revoked.",
  });
  assert.deepEqual(
    transitionWorkStatus({ kind: "accepted" }, { kind: "running" }),
    { kind: "running" }
  );
  assert.deepEqual(transitionWorkStatus({ kind: "running" }, cancelled), {
    commandId: "cancel-A",
    kind: "cancelled",
  });
  for (const next of [
    { kind: "accepted" },
    { kind: "running" },
    completed,
    failed,
  ]) {
    const status = Schema.decodeUnknownSync(WorkStatusSchema)(next);
    assert.deepEqual(transitionWorkStatus(cancelled, status), {
      commandId: "cancel-A",
      kind: "cancelled",
    });
  }
  assert.deepEqual(transitionWorkStatus(completed, { kind: "running" }), {
    kind: "completed",
    reportId: "report-A",
  });
  assert.deepEqual(transitionWorkStatus(failed, { kind: "accepted" }), {
    kind: "failed",
    reason: "Role access was revoked.",
  });
  assert.deepEqual(
    transitionWorkStatus({ kind: "running" }, { kind: "accepted" }),
    { kind: "running" }
  );
});

test("reports retain bounded source and tool provenance before result disclosure", () => {
  const report = {
    contentDependencies: { sourceIds: ["source-A"], toolIds: ["read-record"] },
    id: "report-A",
    key: admission().key,
    kind: "completed",
    text: "The second deployment removed the error.",
  };
  assert.deepEqual(Schema.decodeUnknownSync(WorkReportSchema)(report), report);
  for (const changed of [
    { contentDependencies: undefined },
    { contentDependencies: { sourceIds: [""], toolIds: [] } },
    { contentDependencies: { sourceIds: [], toolIds: [" read-record"] } },
    {
      contentDependencies: {
        sourceIds: Array.from({ length: 513 }, (_, index) => `source-${index}`),
        toolIds: [],
      },
    },
    {
      contentDependencies: {
        sourceIds: [],
        toolIds: Array.from({ length: 257 }, (_, index) => `tool-${index}`),
      },
    },
    { text: "x".repeat(16_001) },
    { kind: "failed" },
  ]) {
    assert.throws(() =>
      Schema.decodeUnknownSync(WorkReportSchema)({ ...report, ...changed })
    );
  }
});

test("command receipts distinguish saved admission from terminal rejection", () => {
  const base = { commandId: "start-A", key: admission().key };
  assert.deepEqual(
    Schema.decodeUnknownSync(TeamCommandReceiptSchema)({
      ...base,
      kind: "accepted",
    }),
    { ...base, kind: "accepted" }
  );
  assert.deepEqual(
    Schema.decodeUnknownSync(TeamCommandReceiptSchema)({
      ...base,
      kind: "rejected",
      reason: "cancelled",
    }),
    { ...base, kind: "rejected", reason: "cancelled" }
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(TeamCommandReceiptSchema)({
      ...base,
      kind: "rejected",
    })
  );
});
