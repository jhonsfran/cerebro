import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { Schema } from "effect";

import {
  WorkAdmissionSchema,
  WorkReportSchema,
  workCellName,
} from "../../packages/contracts/src/work.ts";
import type {
  TeamCommand,
  WorkAdmission,
} from "../../packages/contracts/src/work.ts";
import { addressFor, evidence, waitFor } from "./helpers.ts";
import type { Stack } from "./helpers.ts";
import { restart, runtimeJourney } from "./runtime-journey.ts";

const journey = runtimeJourney("teams");
const admission = (goal: string, timeoutMs = 60_000) => {
  const admittedAt = Date.now();
  return Schema.decodeUnknownSync(WorkAdmissionSchema)({
    admittedAt,
    deadlineAt: admittedAt + timeoutMs,
    goal,
    key: {
      organizationId: "org-team",
      ownerPrincipalId: "owner-team",
      workId: crypto.randomUUID(),
    },
    lead: { agentId: "published-lead", agentVersion: 3 },
    worker: { agentId: "published-worker", agentVersion: 7 },
    limits: { maxTeams: 2, maxWorkers: 2, maxTurns: 8, timeoutMs },
    sourceEventAddress: {
      organizationId: "org-team",
      agentId: "coordinator",
      conversationId: "public-source",
      sessionId: "public-source",
    },
    sourceSlackThread: {
      workspaceId: "T-team",
      channelId: "D-team",
      rootTimestamp: "1800000000.000001",
    },
    contentDependencies: { sourceIds: ["source-A"], toolIds: [] },
  });
};
const call = async (
  stack: Stack,
  work: WorkAdmission,
  path: string,
  body: unknown = {}
) =>
  await fetch(`http://127.0.0.1:${stack.apiPort}/team/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-team-name": workCellName(work.key),
    },
    signal: AbortSignal.timeout(20_000),
  });
const command = async (stack: Stack, input: TeamCommand) => {
  const response = await call(stack, input.work, "control", input);
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json();
};
const inspectionSchema = Schema.Struct({
  state: Schema.Struct({
    modelCalls: Schema.Number,
    phase: Schema.String,
    lead: Schema.NullOr(Schema.Number),
    workers: Schema.Array(
      Schema.Struct({
        nativeId: Schema.Number,
        ownerTaskId: Schema.NullOr(Schema.Number),
      })
    ),
    report: Schema.NullOr(WorkReportSchema),
    pending: Schema.Record(Schema.String, Schema.Number),
  }),
  io: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      role: Schema.String,
      at: Schema.Number,
      body: Schema.String,
    })
  ),
  approvals: Schema.Number,
});
const inspect = async (stack: Stack, work: WorkAdmission) => {
  const response = await call(stack, work, "inspect");
  assert.equal(response.status, 200, await response.clone().text());
  return Schema.decodeUnknownSync(inspectionSchema)(await response.json());
};
const settled = async (stack: Stack, work: WorkAdmission) =>
  await waitFor(
    () => inspect(stack, work),
    (value) => value.state.report !== null,
    30_000
  );

journey(
  "published role models and scope aliases isolate two workers and retain conservative provenance",
  async (stack) => {
    const work = admission("delegate two workers");
    await command(stack, {
      kind: "start",
      id: `start:${work.key.workId}`,
      work,
    });
    const result = await settled(stack, work);
    assert.equal(result.state.phase, "completed");
    assert.equal(result.state.modelCalls, 6);
    assert.equal(result.io.filter((item) => item.kind === "model").length, 6);
    assert.deepEqual(
      [
        ...new Set(
          result.io
            .filter((item) => item.kind === "model")
            .map((item) => item.role)
        ),
      ].toSorted(),
      ["lead", "worker-1", "worker-2"]
    );
    assert.equal(JSON.stringify(result.io).includes("model-lead-v3"), true);
    assert.equal(JSON.stringify(result.io).includes("model-worker-v7"), true);
    assert.equal(JSON.stringify(result.io).includes("team_write"), false);
    assert.equal(result.approvals, 0);
    assert.deepEqual(result.state.report?.contentDependencies, {
      sourceIds: ["source-A", "source-B"],
      toolIds: ["team_read"],
    });
    assert.notEqual(
      result.state.workers[0]?.nativeId,
      result.state.workers[1]?.nativeId
    );
    await evidence(stack, "team-role-models", { work, result });
  }
);

journey(
  "physical request retries share one persisted eight-call budget",
  async (stack) => {
    const work = admission("retry-loop");
    await command(stack, {
      kind: "start",
      id: `start:${work.key.workId}`,
      work,
    });
    const result = await settled(stack, work);
    assert.equal(result.state.modelCalls, 8);
    assert.equal(result.io.filter((item) => item.kind === "model").length, 8);
    assert.equal(result.state.report?.kind, "failed");
    await evidence(stack, "team-model-budget", result);
  }
);

journey(
  "cancel before start is absorbing and conflicting immutable admissions cannot replace it",
  async (stack) => {
    const work = admission("No model may see this.");
    await command(stack, {
      kind: "cancel",
      id: `cancel:${work.key.workId}`,
      work,
    });
    const ignored = await command(stack, {
      kind: "start",
      id: `start:${work.key.workId}`,
      work,
    });
    assert.deepEqual(ignored, {
      commandId: `start:${work.key.workId}`,
      key: work.key,
      kind: "rejected",
      reason: "cancelled",
    });
    const changed = await call(stack, work, "control", {
      kind: "start",
      id: `start:${work.key.workId}`,
      work: { ...work, goal: "Changed private goal." },
    });
    assert.equal(changed.ok, false);
    const result = await settled(stack, work);
    assert.equal(result.state.phase, "cancelled");
    assert.equal(result.state.lead, null);
    assert.deepEqual(result.io, []);
    await evidence(stack, "team-cancel-reorder", result);
  }
);

journey(
  "input arriving before start retains one goal and one immutable input",
  async (stack) => {
    const work = admission("First goal.");
    const input: TeamCommand = {
      kind: "input",
      id: "input-one",
      work,
      text: "Second instruction.",
      contentDependencies: { sourceIds: [], toolIds: [] },
    };
    await command(stack, input);
    await command(stack, input);
    await command(stack, {
      kind: "start",
      id: `start:${work.key.workId}`,
      work,
    });
    const changed = await call(stack, work, "control", {
      ...input,
      text: "Conflicting instruction.",
    });
    assert.equal(changed.ok, false);
    const result = await settled(stack, work);
    assert.ok(result.state.modelCalls >= 1 && result.state.modelCalls <= 2);
    const bodies = JSON.stringify(result.io);
    assert.equal(bodies.includes("Second instruction."), true);
    assert.equal(bodies.includes("Conflicting instruction."), false);
    await evidence(stack, "team-input-reorder", result);
  }
);

journey(
  "receiving worker grants and lead grants both gate private handoffs",
  async (stack) => {
    const narrowWorker = admission("delegate worker-narrow");
    await command(stack, {
      kind: "start",
      id: `start:${narrowWorker.key.workId}`,
      work: narrowWorker,
    });
    const workerResult = await settled(stack, narrowWorker);
    assert.equal(
      workerResult.io.filter(
        (item) => item.kind === "model" && item.role.startsWith("worker")
      ).length,
      0
    );
    const narrowLead = admission("delegate lead-narrow");
    await command(stack, {
      kind: "start",
      id: `start:${narrowLead.key.workId}`,
      work: narrowLead,
    });
    const leadResult = await settled(stack, narrowLead);
    const leadModels = leadResult.io.filter(
      (item) => item.kind === "model" && item.role === "lead"
    );
    assert.equal(
      JSON.stringify(leadModels).includes("Private worker source-B."),
      false
    );
    assert.deepEqual(leadResult.state.report?.contentDependencies, {
      sourceIds: ["source-A", "source-B"],
      toolIds: ["team_read"],
    });
    await evidence(stack, "team-handoff-grants", { workerResult, leadResult });
  }
);

journey(
  "an absolute work deadline aborts a physical model call before its provider timeout",
  async (stack) => {
    const work = admission("hold-model", 1500);
    await command(stack, {
      kind: "start",
      id: `start:${work.key.workId}`,
      work,
    });
    const result = await settled(stack, work);
    const aborted = result.io.find((item) => item.kind === "model-aborted");
    assert.ok(aborted);
    assert.ok(aborted.at <= work.deadlineAt + 2000);
    assert.equal(result.state.report?.kind, "failed");
    await evidence(stack, "team-absolute-deadline", { work, result });
  }
);

journey(
  "a target receipt survives SIGKILL before native lead admission and recovery submits once",
  async (stack) => {
    const work = admission("pause-admission", 120_000);
    const input: TeamCommand = {
      kind: "start",
      id: `start:${work.key.workId}`,
      work,
    };
    await command(stack, input);
    const saved = await inspect(stack, work);
    assert.equal(Object.keys(saved.state.pending).length, 1);
    assert.equal(saved.io.length, 0);
    restart(stack);
    await delay(35_000);
    const readAt = Date.now();
    const recovered = await settled(stack, work);
    assert.equal(recovered.state.modelCalls, 1);
    assert.ok(
      recovered.io.some(
        (item) => item.kind === "model" && item.at < readAt - 1000
      )
    );
    await command(stack, input);
    const replayed = await inspect(stack, work);
    assert.equal(replayed.state.modelCalls, 1);
    await evidence(stack, "team-admission-recovery", {
      work,
      saved,
      recovered,
      replayed,
    });
  }
);

journey(
  "source revocation stops new role dispatch while role execute permissions remain allowed",
  async (stack) => {
    const work = admission("hold-for-revoke");
    await command(stack, {
      kind: "start",
      id: `start:${work.key.workId}`,
      work,
    });
    await waitFor(
      () => inspect(stack, work),
      (value) => value.io.some((item) => item.kind === "model")
    );
    const revoked = await call(stack, work, "revoke");
    const released = await call(stack, work, "release");
    assert.equal(revoked.ok, true);
    assert.equal(released.ok, true);
    const result = await settled(stack, work);
    assert.equal(result.state.modelCalls, 1);
    assert.equal(
      result.io.some((item) => item.kind === "tool"),
      false
    );
    assert.equal(result.state.report?.kind, "failed");
    await evidence(stack, "team-source-revocation", result);
  }
);

journey(
  "a tool started before the work deadline receives a capped abort signal",
  async (stack) => {
    const work = admission("hold-tool", 1500);
    await command(stack, {
      kind: "start",
      id: `start:${work.key.workId}`,
      work,
    });
    const result = await settled(stack, work);
    const aborted = result.io.find((item) => item.kind === "tool-aborted");
    assert.ok(aborted);
    assert.ok(aborted.at <= work.deadlineAt + 2000);
    assert.equal(result.state.report?.kind, "failed");
    await evidence(stack, "team-tool-deadline", { work, result });
  }
);

journey(
  "canonical run limits bound tool fanout below the shared model call budget",
  async (stack) => {
    const work = admission("tool-fanout");
    await command(stack, {
      kind: "start",
      id: `start:${work.key.workId}`,
      work,
    });
    const result = await settled(stack, work);
    assert.equal(result.io.filter((item) => item.kind === "tool").length, 50);
    assert.equal(result.state.modelCalls, 1);
    assert.equal(result.state.report?.kind, "failed");
    await evidence(stack, "team-tool-fanout", result);
  }
);

journey(
  "cancel commits its tombstone before aborting in-flight model execution",
  async (stack) => {
    const work = admission("hold-model");
    await command(stack, {
      kind: "start",
      id: `start:${work.key.workId}`,
      work,
    });
    await waitFor(
      () => inspect(stack, work),
      (value) => value.io.some((item) => item.kind === "model")
    );
    await command(stack, {
      kind: "cancel",
      id: `cancel:${work.key.workId}`,
      work,
    });
    const result = await settled(stack, work);
    assert.equal(result.state.phase, "cancelled");
    assert.equal(
      result.io.some((item) => item.kind === "model-aborted"),
      true
    );
    const late = await command(stack, {
      kind: "input",
      id: "late-input",
      text: "Do not revive.",
      contentDependencies: { sourceIds: [], toolIds: [] },
      work,
    });
    assert.deepEqual(late, {
      commandId: "late-input",
      key: work.key,
      kind: "rejected",
      reason: "cancelled",
    });
    await evidence(stack, "team-cancel-active", result);
  }
);

journey(
  "expired recovery settles and aborts without loading unavailable role configuration",
  async (stack) => {
    const work = admission("pause-admission config-unavailable", 5000);
    await command(stack, {
      kind: "start",
      id: `start:${work.key.workId}`,
      work,
    });
    restart(stack);
    await delay(10_000);
    const result = await inspect(stack, work);
    assert.equal(result.state.phase, "failed");
    assert.deepEqual(result.state.pending, {});
    assert.equal(result.state.modelCalls, 0);
    await evidence(stack, "team-expired-unavailable", result);
  }
);

journey(
  "source dispatch retries keep their event alive after the coordinator answer finishes",
  async (stack) => {
    const address = addressFor("coordinator-company", "background-transport");
    const response = await fetch(
      `http://127.0.0.1:${stack.apiPort}/coord/send`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address,
          operationId: "source-input",
          text: "Start a team.",
        }),
      }
    );
    assert.equal(response.status, 200, await response.clone().text());
    await delay(3000);
    const readAt = Date.now();
    const inspected = await fetch(
      `http://127.0.0.1:${stack.apiPort}/coord/inspect`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      }
    );
    assert.equal(inspected.status, 200, await inspected.clone().text());
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        transport: Schema.Array(
          Schema.Struct({ at: Schema.Number, command: Schema.String })
        ),
      })
    )(await inspected.json());
    assert.equal(result.transport.length, 2);
    assert.equal(result.transport[0]?.command, result.transport[1]?.command);
    assert.ok((result.transport[1]?.at ?? readAt) < readAt - 500);
    await evidence(stack, "source-background-lifetime", result);
  }
);
