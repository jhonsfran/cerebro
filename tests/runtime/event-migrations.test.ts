import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Schema } from "effect";

import { digestToolArguments } from "../../packages/contracts/src/tools.ts";
import {
  TeamCommandSchema,
  WorkAdmissionSchema,
} from "../../packages/contracts/src/work.ts";
import { createModels } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  createRegistry,
  defineDocFamily,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import type { JsonObject } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { openNodeSqliteStorage } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import {
  BotEventReceipts,
  BotEventSequence,
  eventOf,
} from "../../packages/runtime/src/coordinator-event-state.ts";
import { BotEventQueue } from "../../packages/runtime/src/coordinator-events.ts";
import { WorkDocuments } from "../../packages/runtime/src/coordinator-ledger.ts";
import type { CoordinatorWorkRecord } from "../../packages/runtime/src/coordinator-ledger.ts";
import { actor, context, eventFor, setup } from "./subscription-fixture.ts";

test("an actual v1 event intent reopens with its exact payload, digest and pending delivery", async () => {
  const fixture = await setup();
  try {
    const event = await eventFor(fixture, "old-event");
    const digest = await digestToolArguments(event);
    const nativeId = fixture.source("a").native.id;
    const legacy = defineDocFamily({
      kind: BotEventReceipts.definition.kind,
      scope: "session",
      family: true,
      version: 1,
      initial: (_seed: null): { receipt: JsonObject | null } => ({
        receipt: null,
      }),
    });
    const taskId = await fixture.pi().commit(async (tx) => {
      const old = await tx.doc(legacy, event.id, null);
      const queue = await tx.doc(BotEventQueue);
      const deliveryTaskId = await tx.createTask(
        fixture.events().definition,
        { eventId: event.id },
        {
          background: true,
          conversationId: nativeId,
          ownership: { kind: "conversation" },
        }
      );
      old.receipt = {
        event,
        digest,
        route: { kind: "coordinator", nativeId },
        taskId: deliveryTaskId,
        admission: { kind: "held" },
        duplicates: 0,
      };
      queue.pending[event.id] = {
        nativeId,
        taskId: deliveryTaskId,
        internal: false,
      };
      return deliveryTaskId;
    }, context);
    await fixture.reopen();
    await fixture.pi().waitForTask(taskId, context);
    const restored = await fixture.events().read(event.id, actor);
    assert.deepEqual(eventOf(restored), event);
    assert.equal(restored.digest, digest);
    assert.equal(restored.sequence, 0);
    assert.equal(restored.nativeId, nativeId);
    assert.ok(restored.delivery.kind === "coordinator");
    assert.equal(restored.delivery.taskId, taskId);
    assert.ok(
      restored.delivery.admission.kind === "settled" &&
        restored.delivery.admission.outcome === "done"
    );
    assert.equal(
      fixture.eventSubmissions.filter((requestId) => requestId === event.id)
        .length,
      1
    );
    const replay = await fixture.events().admit(event, actor);
    assert.deepEqual(replay.delivery, restored.delivery);
    assert.equal(
      await fixture.pi().snapshot(BotEventSequence, nativeId, context),
      undefined
    );
  } finally {
    await fixture.close();
  }
});

const work = Schema.decodeUnknownSync(WorkAdmissionSchema)({
  version: 2,
  admittedAt: 1_800_000_000_000,
  deadlineAt: 1_800_000_600_000,
  goal: "A queued old work item.",
  key: { organizationId: "org", ownerPrincipalId: "owner", workId: "work" },
  lead: { agentId: "lead", agentVersion: 1 },
  worker: { agentId: "worker", agentVersion: 1 },
  limits: { maxTeams: 2, maxTurns: 8, maxWorkers: 1, timeoutMs: 600_000 },
  sourceEventAddress: {
    agentId: "coordinator",
    conversationId: "primary",
    organizationId: "org",
    sessionId: "primary",
  },
  contentDependencies: { sourceIds: [], toolIds: [] },
});
const open = async (file: string) =>
  await Harness.open(
    await openNodeSqliteStorage(file),
    {
      models: createModels(),
      registry: createRegistry(),
      settings: { extensions: [] },
    },
    context
  );

test("actual v2 work documents retain buffered legacy command bytes through v3 migration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "event-work-migration-"));
  const filename = path.join(directory, "state.sqlite");
  let pi = await open(filename);
  try {
    const command = Schema.decodeUnknownSync(TeamCommandSchema)({
      id: "old-queued-input",
      kind: "input",
      contentDependencies: { sourceIds: [], toolIds: [] },
      text: "Keep the original buffered input.",
      work,
    });
    const bytes = JSON.stringify(command);
    const legacy = defineDocFamily({
      kind: WorkDocuments.definition.kind,
      scope: "session",
      family: true,
      version: 2,
      initial: (_seed: null): { record: CoordinatorWorkRecord | null } => ({
        record: null,
      }),
    });
    await pi.commit(async (tx) => {
      const document = await tx.doc(legacy, work.key.workId, null);
      document.record = {
        admission: work,
        humanOperationId: "old-human",
        status: { kind: "queued" },
        reportId: null,
        pendingCommands: {},
        dispatched: false,
        queuedCommands: { [command.id]: command },
        terminalReport: null,
      };
    }, context);
    await pi.close(context);
    pi = await open(filename);
    const migrated = await pi.snapshot(WorkDocuments, work.key.workId, context);
    assert.ok(migrated?.record);
    assert.equal(migrated.record.humanOperationId, "old-human");
    assert.equal(migrated.record.dispatched, false);
    assert.equal(migrated.record.status.kind, "queued");
    assert.equal(
      JSON.stringify(migrated.record.queuedCommands[command.id]),
      bytes
    );
    assert.equal(
      JSON.stringify(migrated.record.admission),
      JSON.stringify(work)
    );
    await pi.commit(async (tx) => {
      const current = await tx.doc(WorkDocuments, work.key.workId, null);
      assert.ok(current.record);
      current.record.humanOperationId = "updated-human";
    }, context);
    await pi.close(context);
    pi = await open(filename);
    const retained = await pi.snapshot(WorkDocuments, work.key.workId, context);
    assert.equal(retained?.record?.humanOperationId, "updated-human");
    assert.equal(
      JSON.stringify(retained?.record?.queuedCommands[command.id]),
      bytes
    );
  } finally {
    await pi.close(context);
    await rm(directory, { recursive: true });
  }
});
