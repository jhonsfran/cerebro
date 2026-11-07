import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Schema } from "effect";

import { digestToolArguments } from "../../packages/contracts/src/tools.ts";
import { WorkAdmissionSchema } from "../../packages/contracts/src/work.ts";
import { createModels } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  createRegistry,
  defineDoc,
  defineDocFamily,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import type { JsonObject } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { openNodeSqliteStorage } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { BotEventReceipts } from "../../packages/runtime/src/coordinator-event-state.ts";
import {
  WorkDocuments,
  WorkLedger,
} from "../../packages/runtime/src/coordinator-ledger.ts";
import { context, eventFor, setup } from "./subscription-fixture.ts";

test("a v2 event receipt is rejected instead of migrated", async () => {
  const fixture = await setup();
  try {
    const event = await eventFor(fixture, "old-event");
    const digest = await digestToolArguments(event);
    const nativeId = fixture.source("a").native.id;
    const previous = defineDocFamily({
      kind: BotEventReceipts.definition.kind,
      scope: "session",
      family: true,
      version: 2,
      initial: (_seed: null): { receipt: JsonObject | null } => ({
        receipt: null,
      }),
    });
    await fixture.pi().commit(async (tx) => {
      const old = await tx.doc(previous, event.id, null);
      old.receipt = {
        input: event,
        digest,
        nativeId,
        sequence: 0,
        duplicates: 0,
        route: { kind: "coordinator", skipped: [] },
        delivery: {
          kind: "coordinator",
          taskId: 1,
          admission: { kind: "claimed", agentVersion: 1, requestId: event.id },
        },
      };
    }, context);
    await assert.rejects(
      fixture.pi().snapshot(BotEventReceipts, event.id, context),
      /Unsupported coordinator event version/u
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

test("v3 work documents and v2 work indexes are rejected instead of migrated", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "event-work-migration-"));
  const filename = path.join(directory, "state.sqlite");
  let pi = await open(filename);
  try {
    const previousDocuments = defineDocFamily({
      kind: WorkDocuments.definition.kind,
      scope: "session",
      family: true,
      version: 3,
      initial: (_seed: null): { record: JsonObject | null } => ({
        record: null,
      }),
    });
    const previousLedger = defineDoc({
      kind: WorkLedger.definition.kind,
      scope: "session",
      version: 2,
      initial: (): JsonObject => ({ identity: null, active: {}, queue: [] }),
    });
    await pi.commit(async (tx) => {
      const document = await tx.doc(previousDocuments, work.key.workId, null);
      document.record = {
        admission: work,
        humanOperationId: "old-human",
        status: { kind: "queued" },
        reportId: null,
        pendingCommands: {},
        dispatched: false,
        queuedCommands: {},
        terminalReport: null,
      };
      await tx.doc(previousLedger);
    }, context);
    await pi.close(context);
    pi = await open(filename);
    await assert.rejects(
      pi.snapshot(WorkDocuments, work.key.workId, context),
      /Unsupported coordinator work version/u
    );
    await assert.rejects(
      pi.snapshot(WorkLedger, context),
      /Unsupported coordinator index version/u
    );
  } finally {
    await pi.close(context);
    await rm(directory, { recursive: true });
  }
});
