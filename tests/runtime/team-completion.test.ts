import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Schema } from "effect";

import {
  BoundedContentDependenciesSchema,
  WorkAdmissionSchema,
} from "../../packages/contracts/src/work.ts";
import type {
  WorkAdmission,
  WorkReport,
} from "../../packages/contracts/src/work.ts";
import { createModels } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  createRegistry,
  defineDocFamily,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { openNodeSqliteStorage } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import { createTeamCompletion } from "../../packages/runtime/src/team-completion.ts";
import { TeamState } from "../../packages/runtime/src/team-state.ts";

const context = piContext();
const Provenance = defineDocFamily({
  kind: "test.private-role-provenance",
  scope: "session",
  family: true,
  version: 1,
  initial: (dependencies: WorkAdmission["contentDependencies"]) => ({
    dependencies,
  }),
});
const fixture = async (kind: "sources" | "tools", block = false) => {
  const directory = await mkdtemp(path.join(tmpdir(), "team-completion-"));
  const filename = path.join(directory, "native.sqlite");
  const open = async () =>
    Harness.open(
      await openNodeSqliteStorage(filename),
      {
        models: createModels(),
        registry: createRegistry(),
        settings: { extensions: [] },
      },
      context
    );
  let pi = await open();
  const root = await pi.root(context);
  const admittedAt = Date.now();
  const work = Schema.decodeUnknownSync(WorkAdmissionSchema)({
    admittedAt,
    deadlineAt: admittedAt + 60_000,
    goal: "private-goal-marker",
    key: {
      organizationId: "org",
      ownerPrincipalId: "owner",
      workId: `overflow-${kind}`,
    },
    lead: { agentId: "lead", agentVersion: 1 },
    worker: { agentId: "worker", agentVersion: 1 },
    limits: { maxTeams: 2, maxWorkers: 2, maxTurns: 8, timeoutMs: 60_000 },
    sourceEventAddress: {
      organizationId: "org",
      agentId: "coordinator",
      conversationId: "public",
      sessionId: "public",
    },
    sourceSlackThread: {
      workspaceId: "T",
      channelId: "D",
      rootTimestamp: "1800000000.000001",
    },
    contentDependencies: { sourceIds: [], toolIds: [] },
  });
  const first = Schema.decodeUnknownSync(BoundedContentDependenciesSchema)({
    sourceIds:
      kind === "sources"
        ? Array.from({ length: 512 }, (_, index) => `private-source-${index}`)
        : [],
    toolIds:
      kind === "tools"
        ? Array.from({ length: 256 }, (_, index) => `private-tool-${index}`)
        : [],
  });
  const second = Schema.decodeUnknownSync(BoundedContentDependenciesSchema)({
    sourceIds: kind === "sources" ? ["private-source-extra"] : [],
    toolIds: kind === "tools" ? ["private-tool-extra"] : [],
  });
  await pi.commit(async (tx) => {
    const state = await tx.doc(TeamState);
    state.admission = work;
    state.phase = "running";
    state.lead = root.id;
    await tx.doc(Provenance, "lead", first);
    await tx.doc(Provenance, "worker", second);
  }, context);
  const entered = Promise.withResolvers<boolean>();
  const released = Promise.withResolvers<boolean>();
  const reports: WorkReport[] = [];
  const read = async (key: string) => {
    if (block && key === "worker") {
      entered.resolve(true);
      await released.promise;
    }
    const stored = await pi.snapshot(Provenance, key, context);
    assert.ok(stored);
    return stored.dependencies;
  };
  const wake = createTeamCompletion({
    pi,
    work,
    now: Date.now,
    roles: [
      { dependencies: () => read("lead") },
      { dependencies: () => read("worker") },
    ],
    abort: () => root.abort(context),
    holdAdmissions: () => Promise.resolve(),
    emitReport: (report) => {
      reports.push(report);
      return Promise.resolve();
    },
  });
  return {
    work,
    pi: () => pi,
    wake,
    entered: entered.promise,
    release: () => released.resolve(true),
    reports,
    inspect: () => pi.snapshot(TeamState, context),
    privateDependencies: () =>
      Promise.all([
        pi.snapshot(Provenance, "lead", context),
        pi.snapshot(Provenance, "worker", context),
      ]),
    reopen: async () => {
      await pi.close(context);
      pi = await open();
    },
    close: async () => {
      released.resolve(true);
      await pi.close(context);
      await rm(directory, { recursive: true });
    },
  };
};

for (const kind of ["sources", "tools"] as const) {
  test(`${kind} provenance overflow saves a stable constant terminal report and retains every private dependency`, async () => {
    const subject = await fixture(kind);
    try {
      const before = await subject.privateDependencies();
      assert.equal(await subject.wake(subject.work.deadlineAt), undefined);
      const state = await subject.inspect();
      assert.equal(state?.phase, "failed");
      assert.deepEqual(state?.report, {
        id: `report:${subject.work.key.workId}`,
        key: subject.work.key,
        kind: "failed",
        reason: "The team could not complete within its execution limits.",
        contentDependencies: { sourceIds: [], toolIds: [] },
      });
      assert.equal(subject.reports.length, 1);
      assert.equal(JSON.stringify(subject.reports).includes("private-"), false);
      assert.deepEqual(await subject.privateDependencies(), before);
      await subject.reopen();
      const reopened = await subject.inspect();
      assert.deepEqual(reopened?.report, state?.report);
      assert.deepEqual(await subject.privateDependencies(), before);
    } finally {
      await subject.close();
    }
  });
}

test("cancellation during oversized report preparation remains absorbing and emits a constant cancellation receipt", async () => {
  const subject = await fixture("sources", true);
  try {
    const pending = subject.wake(subject.work.deadlineAt);
    await subject.entered;
    await subject.pi().commit(async (tx) => {
      const state = await tx.doc(TeamState);
      state.phase = "cancelled";
    }, context);
    subject.release();
    await pending;
    const state = await subject.inspect();
    assert.equal(state?.phase, "cancelled");
    assert.deepEqual(state?.report, {
      id: `report:${subject.work.key.workId}`,
      key: subject.work.key,
      kind: "cancelled",
      contentDependencies: { sourceIds: [], toolIds: [] },
    });
    const privateValues = await subject.privateDependencies();
    assert.equal(privateValues[0]?.dependencies.sourceIds.length, 512);
    assert.equal(privateValues[1]?.dependencies.sourceIds.length, 1);
    assert.equal(subject.reports.length, 1);
  } finally {
    await subject.close();
  }
});
