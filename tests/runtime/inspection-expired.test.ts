import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { test } from "node:test";

import { Schema } from "effect";

import { id } from "../../packages/contracts/src/identity.ts";
import { WorkAdmissionSchema } from "../../packages/contracts/src/work.ts";
import { createModels } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  createRegistry,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { NodeSqliteDatabase } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { SqliteStorage } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/storage.js";
import {
  initializeContentSchema,
  readRecordedContent,
} from "../../packages/runtime/src/content-dependency-store.ts";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import { receiveExpiredTeam } from "../../packages/runtime/src/team-expiration.ts";
import { readTeamInspection } from "../../packages/runtime/src/team-inspection.ts";
import { TeamState } from "../../packages/runtime/src/team-state.ts";
import { drainTerminalTeam } from "../../packages/runtime/src/team-terminal.ts";

test("an actual expired start remains inspectable without a role or prior provenance schema", async () => {
  const database = new DatabaseSync(":memory:");
  const storage = {
    sql: {
      exec: (query: string, ...bindings: SQLInputValue[]) => {
        const rows = database.prepare(query).all(...bindings);
        return { toArray: () => rows };
      },
    },
  } as unknown as DurableObjectStorage;
  const registry = createRegistry();
  const context = piContext();
  const pi = await Harness.open(
    await SqliteStorage.open(new NodeSqliteDatabase(database)),
    {
      models: createModels(),
      registry,
      settings: { extensions: [] },
    },
    context
  );
  try {
    const now = Date.now();
    const work = Schema.decodeUnknownSync(WorkAdmissionSchema)({
      version: 2,
      admittedAt: now - 120_000,
      deadlineAt: now - 60_000,
      goal: "Expired before role configuration.",
      key: {
        organizationId: "org",
        ownerPrincipalId: "owner",
        workId: "expired-work",
      },
      lead: { agentId: "missing-lead", agentVersion: 1 },
      worker: { agentId: "missing-worker", agentVersion: 1 },
      limits: { maxTeams: 2, maxWorkers: 1, maxTurns: 8, timeoutMs: 60_000 },
      sourceEventAddress: {
        organizationId: "org",
        agentId: "source",
        conversationId: "source",
        sessionId: "source",
      },
      contentDependencies: { sourceIds: [], toolIds: [] },
    });
    const result = await receiveExpiredTeam(pi, registry, {
      kind: "start",
      id: "expired-start",
      work,
    });
    assert.equal(result.kind, "rejected");
    assert.throws(
      () => readRecordedContent(storage, id.session("no-role")),
      /no such table/u
    );
    await pi.commit(() => initializeContentSchema(storage), context);
    await pi.commit(() => initializeContentSchema(storage), context);
    assert.deepEqual(readRecordedContent(storage, id.session("no-role")), {
      sourceIds: [],
      toolIds: [],
      history: [],
    });
    await drainTerminalTeam(pi);
    const frame = await readTeamInspection({
      pi,
      work,
      query: { kind: "team", workId: work.key.workId },
    });
    assert.ok(frame.kind === "team" && frame.team.kind === "available");
    assert.equal(frame.team.sealed, true);
    assert.deepEqual(frame.team.roles, []);
    assert.equal(frame.team.requestReservations, 0);
    assert.equal(frame.team.result?.kind, "failed");
    const before = await pi.snapshot(TeamState, context);
    assert.deepEqual(
      await readTeamInspection({
        pi,
        work,
        query: { kind: "team", workId: work.key.workId },
      }),
      frame
    );
    assert.deepEqual(await pi.snapshot(TeamState, context), before);
  } finally {
    await pi.close(context);
  }
});
