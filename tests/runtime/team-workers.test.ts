import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Schema } from "effect";

import { id } from "../../packages/contracts/src/identity.ts";
import type { AgentDefinition } from "../../packages/contracts/src/session.ts";
import {
  DEFAULT_TEAM_LIMITS,
  WorkAdmissionSchema,
  resolveWorkLimits,
} from "../../packages/contracts/src/work.ts";
import type { WorkLimits } from "../../packages/contracts/src/work.ts";
import {
  LiveDoc,
  UserEntry,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import type { ConversationId } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { readTeamInspection } from "../../packages/runtime/src/team-inspection.ts";
import {
  TeamState,
  teamChildren,
  workerRequestId,
} from "../../packages/runtime/src/team-state.ts";
import { context, teamProvenanceFixture } from "./team-provenance-fixture.ts";

type Fixture = Awaited<ReturnType<typeof teamProvenanceFixture>>;
const waitError = (limit: number) =>
  `The team already runs its maximum number of workers (${limit}). Wait for their answers before delegating another question.`;

const admission = (limits: WorkLimits) => {
  const admittedAt = Date.now();
  return Schema.decodeUnknownSync(WorkAdmissionSchema)({
    version: 3,
    admittedAt,
    deadlineAt: admittedAt + limits.timeoutMs,
    goal: "Answer two independent private questions.",
    key: { organizationId: "org", ownerPrincipalId: "owner", workId: "work" },
    agent: { agentId: "coordinator", agentVersion: 1 },
    limits,
    sourceEventAddress: {
      organizationId: "org",
      agentId: "coordinator",
      conversationId: "primary",
      sessionId: "primary",
    },
    contentDependencies: { sourceIds: [], toolIds: [] },
  });
};
const agent = (team?: AgentDefinition["team"]): AgentDefinition => ({
  organizationId: id.organization("org"),
  agentId: id.agent("coordinator"),
  version: 1,
  instructions: "Answer briefly.",
  model: "model:0",
  enabledToolIds: [],
  grants: [],
  ...(team ? { team } : {}),
});
const start = (f: Fixture) => ({
  id: "start",
  kind: "start" as const,
  work: f.work,
});
const until = async (
  check: () => boolean | Promise<boolean>,
  deadline = Date.now() + 10_000
): Promise<void> => {
  if (await check()) {
    return;
  }
  assert.ok(Date.now() < deadline, "the awaited team state arrived");
  await delay(10);
  await until(check, deadline);
};
const state = async (f: Fixture) => {
  const value = await f.pi().snapshot(TeamState, context);
  assert.ok(value);
  return value;
};
const childCount = async (f: Fixture) => {
  const value = await state(f);
  return Object.keys(value.children).length;
};
const finish = async (f: Fixture) => {
  const { pending, lead } = await state(f);
  await Promise.all(
    Object.values(pending).map((taskId) => f.pi().waitForTask(taskId, context))
  );
  assert.ok(lead);
  const native = await f.pi().conversation(lead, context);
  await native?.waitForIdle(context);
  await f.runtime().wake(f.work.deadlineAt);
  return await state(f);
};
const combined = (text: string | undefined) =>
  text?.replace("Combined: ", "").split(" | ").toSorted();
const workerPrompts = (f: Fixture) =>
  f.prompts
    .filter((prompt) => prompt.role > 0)
    .flatMap((prompt) => prompt.texts)
    .toSorted();
const doneToolCalls = async (f: Fixture, lead: ConversationId) => {
  const live = await f.pi().snapshot(LiveDoc, lead, context);
  return (live?.tools ?? []).filter((tool) => tool.status === "done").length;
};

test("two delegate_worker calls in one round start two children that both answer into the lead's report", async () => {
  const f = await teamProvenanceFixture({
    work: admission(DEFAULT_TEAM_LIMITS),
    delegate: ["Question one.", "Question two."],
  });
  try {
    await f.runtime().receive(start(f));
    const final = await finish(f);
    assert.equal(final.report?.kind, "completed");
    assert.deepEqual(
      combined(final.report.kind === "completed" ? final.report.text : ""),
      ["Answer from role 1.", "Answer from role 2."]
    );
    const children = teamChildren(final);
    assert.deepEqual(
      children.map((child) => child.index),
      [1, 2]
    );
    assert.notEqual(children[0]?.nativeId, children[1]?.nativeId);
    assert.notEqual(children[0]?.ownerTaskId, children[1]?.ownerTaskId);
    assert.deepEqual(workerPrompts(f), ["Question one.", "Question two."]);
    const submissions = await f
      .pi()
      .commit(
        (tx) =>
          Promise.all(
            children.map((child) =>
              tx.submissionByRequest(
                child.nativeId,
                workerRequestId(child.ownerTaskId)
              )
            )
          ),
        context
      );
    assert.deepEqual(
      submissions.map((submission) => submission?.status),
      ["done", "done"]
    );
  } finally {
    await f.close();
  }
});

test("a delegate_worker call beyond maxWorkers returns the wait error and starts no child", async () => {
  const f = await teamProvenanceFixture({
    work: admission(DEFAULT_TEAM_LIMITS),
    delegate: ["Question one.", "Question two.", "Question three."],
  });
  try {
    f.holdWorkers();
    await f.runtime().receive(start(f));
    await until(async () => (await childCount(f)) === 2);
    const { lead } = await state(f);
    assert.ok(lead);
    await until(async () => (await doneToolCalls(f, lead)) === 1);
    assert.equal(await childCount(f), 2);
    f.releaseWorkers();
    const final = await finish(f);
    assert.deepEqual(
      combined(final.report?.kind === "completed" ? final.report.text : ""),
      ["Answer from role 1.", "Answer from role 2.", waitError(2)]
    );
    assert.deepEqual(Object.keys(final.children).toSorted(), ["1", "2"]);
    assert.equal(workerPrompts(f).length, 2);
  } finally {
    await f.close();
  }
});

test("a restart between child creation and the answer reuses the same children and submissions", async () => {
  const f = await teamProvenanceFixture({
    work: admission(DEFAULT_TEAM_LIMITS),
    delegate: ["Question one.", "Question two."],
  });
  try {
    f.holdWorkers();
    await f.runtime().receive(start(f));
    await until(() => f.calls.filter((role) => role > 0).length === 2);
    const before = await state(f);
    assert.equal(Object.keys(before.children).length, 2);
    await f.reopen();
    f.releaseWorkers();
    const final = await finish(f);
    assert.deepEqual(final.children, before.children);
    assert.deepEqual(
      combined(final.report?.kind === "completed" ? final.report.text : ""),
      ["Answer from role 1.", "Answer from role 2."]
    );
    const userEntries = await Promise.all(
      teamChildren(final).map(async (child) => {
        const native = await f.pi().conversation(child.nativeId, context);
        assert.ok(native);
        const page = await native.entries({}, 64, undefined, context);
        return page.items.filter((entry) => entry.kind === UserEntry.kind)
          .length;
      })
    );
    assert.deepEqual(userEntries, [1, 1]);
  } finally {
    await f.close();
  }
});

test("the shared model call budget counts the lead and every child", async () => {
  const counted = await teamProvenanceFixture({
    work: admission(DEFAULT_TEAM_LIMITS),
    delegate: ["Question one.", "Question two."],
  });
  try {
    await counted.runtime().receive(start(counted));
    const final = await finish(counted);
    assert.equal(final.report?.kind, "completed");
    assert.equal(final.modelCalls, 4);
    assert.deepEqual(counted.calls.toSorted(), [0, 0, 1, 2]);
  } finally {
    await counted.close();
  }
  const capped = await teamProvenanceFixture({
    work: admission({ ...DEFAULT_TEAM_LIMITS, maxTurns: 3 }),
    delegate: ["Question one.", "Question two."],
  });
  try {
    await capped.runtime().receive(start(capped));
    const final = await finish(capped);
    assert.equal(final.modelCalls, 3);
    assert.deepEqual(capped.calls.toSorted(), [0, 1, 2]);
    assert.equal(final.report?.kind, "failed");
  } finally {
    await capped.close();
  }
});

test("team limits published on the agent bound its Team while an agent without them uses the installation defaults", async () => {
  const limited = resolveWorkLimits(
    agent({ limits: { maxWorkers: 1, maxTurns: 6 } }),
    DEFAULT_TEAM_LIMITS
  );
  assert.deepEqual(limited, {
    ...DEFAULT_TEAM_LIMITS,
    maxWorkers: 1,
    maxTurns: 6,
  });
  const narrow = await teamProvenanceFixture({
    work: admission(limited),
    delegate: ["Question one.", "Question two."],
  });
  try {
    narrow.holdWorkers();
    await narrow.runtime().receive(start(narrow));
    const { lead } = await state(narrow);
    assert.ok(lead);
    await until(async () => (await doneToolCalls(narrow, lead)) === 1);
    narrow.releaseWorkers();
    const final = await finish(narrow);
    assert.deepEqual(
      combined(final.report?.kind === "completed" ? final.report.text : ""),
      ["Answer from role 1.", waitError(1)]
    );
    assert.deepEqual(Object.keys(final.children), ["1"]);
  } finally {
    await narrow.close();
  }
  const defaults = resolveWorkLimits(agent(), DEFAULT_TEAM_LIMITS);
  assert.deepEqual(defaults, DEFAULT_TEAM_LIMITS);
  const wide = await teamProvenanceFixture({
    work: admission(defaults),
    delegate: ["Question one.", "Question two."],
  });
  try {
    await wide.runtime().receive(start(wide));
    const final = await finish(wide);
    assert.deepEqual(Object.keys(final.children).toSorted(), ["1", "2"]);
    assert.equal(final.report?.kind, "completed");
  } finally {
    await wide.close();
  }
});

test("the Inspector lists the lead and each child with its owner task, request, and transcript", async () => {
  const f = await teamProvenanceFixture({
    work: admission(DEFAULT_TEAM_LIMITS),
    delegate: ["Question one.", "Question two."],
  });
  try {
    await f.runtime().receive(start(f));
    const final = await finish(f);
    const frame = await readTeamInspection({
      pi: f.pi(),
      work: f.work,
      query: { kind: "team", workId: f.work.key.workId },
    });
    assert.equal(frame.kind, "team");
    assert.equal(frame.team.kind, "available");
    const children = teamChildren(final);
    assert.deepEqual(
      frame.team.roles.map((role) => ({
        slot: role.slot,
        role: role.role,
        modelId: role.modelId,
        running: role.running,
        ownerTaskId: role.ownerTaskId,
        requestId: role.requestId,
        startedAt: role.startedAt,
      })),
      [
        {
          slot: 0,
          role: "lead",
          modelId: "model:0",
          running: false,
          ownerTaskId: null,
          requestId: null,
          startedAt: null,
        },
        ...children.map((child) => ({
          slot: child.index,
          role: "worker",
          modelId: `model:${child.index}`,
          running: false,
          ownerTaskId: String(child.ownerTaskId),
          requestId: `worker:${child.ownerTaskId}`,
          startedAt: child.startedAt,
        })),
      ]
    );
    const transcript = await readTeamInspection({
      pi: f.pi(),
      work: f.work,
      query: { kind: "transcript", workId: f.work.key.workId, role: 2 },
    });
    assert.equal(transcript.kind, "transcript");
    const [question, answer, ...rest] = transcript.messages.map(
      (message) => message.content.text
    );
    assert.ok(question === "Question one." || question === "Question two.");
    assert.equal(answer, "Answer from role 2.");
    assert.deepEqual(rest, []);
  } finally {
    await f.close();
  }
});
