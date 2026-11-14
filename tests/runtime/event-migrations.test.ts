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
import {
  WorkDocuments,
  WorkLedger,
} from "../../packages/runtime/src/coordinator-ledger.ts";
import { Replies } from "../../packages/runtime/src/replies.ts";
import { ReminderOrigins } from "../../packages/runtime/src/saved-timer-state.ts";
import { Receipts } from "../../packages/runtime/src/triggers.ts";
import { context, eventFor, setup } from "./subscription-fixture.ts";

test("a pre-cutover v3 event receipt is rejected instead of read as a trigger receipt", async () => {
  const fixture = await setup();
  try {
    const event = await eventFor(fixture, "old-event");
    const digest = await digestToolArguments(event);
    const nativeId = fixture.source("a").native.id;
    const previous = defineDocFamily({
      kind: Receipts.definition.kind,
      scope: "session",
      family: true,
      version: 3,
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
      fixture.pi().snapshot(Receipts, event.id, context),
      /Unsupported trigger receipt version/u
    );
  } finally {
    await fixture.close();
  }
});

test("pre-cutover reply records and reminder origins are rejected instead of migrated", async () => {
  const fixture = await setup();
  try {
    const nativeId = fixture.source("a").native.id;
    const previousReply = defineDocFamily({
      kind: Replies.definition.kind,
      scope: "session",
      family: true,
      version: 1,
      initial: (_seed: null): { record: JsonObject | null } => ({
        record: null,
      }),
    });
    const previousOrigin = defineDocFamily({
      kind: ReminderOrigins.definition.kind,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      family: true,
      version: 1,
      initial: (_seed: null): { record: JsonObject | null } => ({
        record: null,
      }),
    });
    await fixture.pi().commit(async (tx) => {
      const reply = await tx.doc(previousReply, "old-reply", null);
      reply.record = { eventId: "old-reply", text: "old" };
      const origin = await tx.doc(
        previousOrigin,
        nativeId,
        "old-reminder",
        null
      );
      origin.record = { creatingEventId: null, reply: { kind: "web" } };
    }, context);
    await assert.rejects(
      fixture.pi().snapshot(Replies, "old-reply", context),
      /Unsupported coordinator reply version/u
    );
    await assert.rejects(
      fixture.pi().snapshot(ReminderOrigins, nativeId, "old-reminder", context),
      /Unsupported reminder origin version/u
    );
  } finally {
    await fixture.close();
  }
});

const work = Schema.decodeUnknownSync(WorkAdmissionSchema)({
  version: 3,
  admittedAt: 1_800_000_000_000,
  deadlineAt: 1_800_000_600_000,
  goal: "A queued old work item.",
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

test("v3 work documents are rejected while compatible v2 indexes survive restart", async () => {
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
    assert.deepEqual(await pi.snapshot(WorkLedger, context), {
      identity: null,
      active: {},
      queue: [],
    });
  } finally {
    await pi.close(context);
    await rm(directory, { recursive: true });
  }
});
