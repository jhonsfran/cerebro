import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { PortResult } from "../../packages/contracts/src/port.ts";
import type {
  RunState,
  SessionReceipt,
  SessionSnapshot,
  SessionStreamItem,
} from "../../packages/contracts/src/session.ts";
import {
  agentFor,
  addressFor,
  compose,
  effectOptions,
  fixtureContext,
  messageEvent,
  request,
  waitFor,
} from "./helpers.ts";

const stack = {
  apiPort: 18_875,
  fixturePort: 18_876,
  holdAfterEffect: false,
  project: "cerebro-runtime-isolation",
} as const;
const companyA = addressFor("company-a", "conversation-1");
const companyB = addressFor("company-b", "conversation-1");

before(() => {
  compose(stack, ["up", "--build", "-d", "--wait"]);
});

after(() => {
  compose(stack, ["down", "-v"]);
});

const inspect = async (address: typeof companyA) =>
  await request<PortResult<SessionSnapshot>>(stack, "/runtime/inspect", {
    address,
  });

const stream = async (address: typeof companyA, cursor?: string) =>
  await request<PortResult<SessionStreamItem[]>>(stack, "/runtime/stream", {
    address,
    cursor,
  });

test("duplicate delivery and operation conflict remain local to one company", async () => {
  const eventA = messageEvent(companyA, "event-a");
  const optionsA = effectOptions("operation-a", "sha256:operation-a");
  const first = await request<PortResult<SessionReceipt>>(
    stack,
    "/runtime/submit",
    {
      agent: agentFor(companyA, 3),
      event: eventA,
      options: optionsA,
    }
  );
  assert.equal(first.status, "ok");
  if (first.status !== "ok") {
    return;
  }
  assert.equal(first.value.replayed, false);
  const duplicate = await request<PortResult<SessionReceipt>>(
    stack,
    "/runtime/submit",
    {
      agent: agentFor(companyA, 3),
      event: eventA,
      options: optionsA,
    }
  );
  assert.equal(duplicate.status, "ok");
  if (duplicate.status === "ok") {
    assert.equal(duplicate.value.replayed, true);
    assert.equal(duplicate.value.runId, first.value.runId);
  }
  const changed = await request<PortResult<SessionReceipt>>(
    stack,
    "/runtime/submit",
    {
      agent: agentFor(companyA, 3),
      event: {
        ...eventA,
        event: { payload: { text: "Changed" }, type: "user.message" },
      },
      options: optionsA,
    }
  );
  assert.equal(changed.status, "conflict");
  const digestConflict = await request<PortResult<SessionReceipt>>(
    stack,
    "/runtime/submit",
    {
      agent: agentFor(companyA, 3),
      event: eventA,
      options: { ...optionsA, requestDigest: "sha256:changed" },
    }
  );
  assert.equal(digestConflict.status, "conflict");

  const eventB = messageEvent(companyB, "event-b");
  const second = await request<PortResult<SessionReceipt>>(
    stack,
    "/runtime/submit",
    {
      agent: agentFor(companyB, 7),
      event: eventB,
      options: effectOptions("operation-b", "sha256:operation-b"),
    }
  );
  assert.equal(second.status, "ok");
  const snapshotA = await inspect(companyA);
  const snapshotB = await inspect(companyB);
  assert.equal(snapshotA.status, "ok");
  assert.equal(snapshotB.status, "ok");
  if (snapshotA.status === "ok" && snapshotB.status === "ok") {
    assert.equal(snapshotA.value.address.organizationId, "company-a");
    assert.equal(snapshotB.value.address.organizationId, "company-b");
    assert.equal(snapshotA.value.runs.length, 1);
    assert.equal(snapshotB.value.runs.length, 1);
    assert.equal(snapshotA.value.agentVersion, 3);
    assert.equal(snapshotB.value.agentVersion, 7);
  }
});

test("the stream cursor and cancellation survive a process restart", async () => {
  const approvalStream = await waitFor(
    async () => await stream(companyA),
    (result) =>
      result.status === "ok" &&
      result.value.some((item) => item.type === "approval"),
    120_000
  );
  assert.equal(approvalStream.status, "ok");
  if (approvalStream.status !== "ok") {
    return;
  }
  const approval = approvalStream.value.find(
    (item) => item.type === "approval"
  );
  assert.ok(approval);
  const afterApproval = await stream(companyA, approval.cursor);
  assert.equal(afterApproval.status, "ok");
  if (afterApproval.status === "ok") {
    assert.equal(
      afterApproval.value.some((item) => item.cursor === approval.cursor),
      false
    );
  }
  const snapshot = await inspect(companyA);
  assert.equal(snapshot.status, "ok");
  if (snapshot.status !== "ok") {
    return;
  }
  const runId = snapshot.value.runs[0]?.runId;
  assert.ok(runId);
  const command = {
    address: companyA,
    context: fixtureContext("company-a"),
    runId,
    type: "cancel",
  };
  const options = effectOptions("cancel-a", "sha256:cancel-a");
  const cancelled = await request<PortResult<RunState>>(
    stack,
    "/runtime/cancel",
    { command, options }
  );
  assert.equal(cancelled.status, "ok");
  if (cancelled.status === "ok") {
    assert.equal(cancelled.value.state, "cancelled");
  }
  const replay = await request<PortResult<RunState>>(stack, "/runtime/cancel", {
    command,
    options,
  });
  assert.deepEqual(replay, cancelled);
  compose(stack, ["kill", "-s", "SIGKILL", "celld"]);
  compose(stack, ["up", "-d", "--wait", "celld"]);
  const afterRestart = await waitFor(
    async () => await inspect(companyA),
    (result) =>
      result.status === "ok" && result.value.runs[0]?.state === "cancelled",
    30_000
  );
  assert.equal(afterRestart.status, "ok");
  if (afterRestart.status === "ok") {
    assert.equal(afterRestart.value.runs[0]?.state, "cancelled");
  }
  const resumed = await stream(companyA, approval.cursor);
  assert.equal(resumed.status, "ok");
  if (resumed.status === "ok") {
    assert.equal(
      resumed.value.some(
        (item) => item.type === "run" && item.run.state === "cancelled"
      ),
      true
    );
  }
});

test("the outbox retries after PostgreSQL returns", async () => {
  compose(stack, ["stop", "postgres"]);
  const address = addressFor("company-c", "conversation-1");
  const event = messageEvent(address, "event-outbox");
  const submitted = await request<PortResult<SessionReceipt>>(
    stack,
    "/runtime/submit",
    {
      agent: agentFor(address, 1),
      event,
      options: effectOptions("operation-outbox", "sha256:operation-outbox"),
    }
  );
  assert.equal(submitted.status, "ok");
  compose(stack, ["up", "-d", "--wait", "postgres"]);
  await waitFor(
    () => {
      const output = compose(stack, [
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "runtime",
        "-d",
        "runtime",
        "-tA",
        "-c",
        `select count(*) from cerebro_audit_event where organization_id='company-c'`,
      ]);
      return Number(output.trim());
    },
    (count) => count > 0,
    120_000
  );
  const output = compose(stack, [
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "runtime",
    "-d",
    "runtime",
    "-tA",
    "-c",
    `select count(*) - count(distinct event_id) from cerebro_audit_event where organization_id='company-c'`,
  ]);
  assert.equal(Number(output.trim()), 0);
});

test("ledger migration preserves existing Session 0 records", async () => {
  const name = "existing-session";
  const seeded = await fetch(
    `http://127.0.0.1:${stack.apiPort}/migration/${name}/seed`,
    { method: "POST" }
  );
  assert.equal(seeded.status, 200);
  const upgraded = await fetch(
    `http://127.0.0.1:${stack.apiPort}/migration/${name}/upgrade`,
    { method: "POST" }
  );
  assert.equal(upgraded.status, 200);
  assert.deepEqual(await upgraded.json(), {
    result: "legacy-result",
    sessionId: "legacy-session",
    version: "3",
  });
});

test("PostgreSQL projection accepts a repeated event ID once", async () => {
  const eventId = "projection-duplicate";
  const replayed = await fetch(
    `http://127.0.0.1:${stack.apiPort}/audit/replay`,
    {
      body: JSON.stringify({
        agentId: "agent-1",
        eventId,
        kind: "audit",
        name: "run.completed",
        occurredAt: Date.now(),
        organizationId: "company-a",
        payload: { state: "completed" },
        runId: "run-a",
        sessionId: "session-a",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }
  );
  assert.equal(replayed.status, 200);
  assert.deepEqual(await replayed.json(), { statuses: [200, 200] });
  const count = compose(stack, [
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "runtime",
    "-d",
    "runtime",
    "-tA",
    "-c",
    `select count(*) from cerebro_audit_event where event_id='${eventId}'`,
  ]);
  assert.equal(Number(count.trim()), 1);
});

test("production operation receipt survives SDK migration and native process restart", async () => {
  const name = "production-journal";
  const write = await fetch(
    `http://127.0.0.1:${stack.apiPort}/migration/${name}/journal-write`,
    { method: "POST" }
  );
  assert.equal(write.status, 200);
  const saved = await write.json();
  assert.equal(saved.status, "ok");
  assert.equal(saved.value.state, "outcome-recorded");
  assert.deepEqual(saved.value.result, { status: "ok", value: { count: 1 } });
  assert.deepEqual(saved.value.incurred, { unit: "credits", units: 3 });
  compose(stack, ["kill", "-s", "SIGKILL", "celld"]);
  compose(stack, ["up", "-d", "--wait", "celld"]);
  const recovered = await waitFor(
    async () => {
      const response = await fetch(
        `http://127.0.0.1:${stack.apiPort}/migration/${name}/journal-read`,
        { method: "POST" }
      );
      assert.equal(response.status, 200);
      return await response.json();
    },
    (result) => result.status === "ok",
    30_000
  );
  assert.deepEqual(recovered, saved);
});
