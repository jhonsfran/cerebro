import assert from "node:assert/strict";
import { test } from "node:test";

import type { PortResult } from "../../packages/contracts/src/port.ts";
import type {
  RunState,
  SessionReceipt,
  SessionSnapshot,
  SessionStreamItem,
} from "../../packages/contracts/src/session.ts";
import {
  addressFor,
  compose,
  effectOptions,
  fixtureContext,
  getFixture,
  messageEvent,
  releaseEffect,
  request,
  waitFor,
} from "./helpers.ts";

interface EffectRecord {
  readonly calls: number;
  readonly effects: number;
  readonly held: boolean;
}

const runCrashCase = async (
  mode: "idempotent" | "non-idempotent",
  offset: number
): Promise<void> => {
  const stack = {
    apiPort: 18_865 + offset,
    effectMode: mode,
    fixturePort: 18_866 + offset,
    holdAfterEffect: true,
    project: `cerebro-runtime-${mode}`,
  } as const;
  const address = addressFor(`company-${mode}`, "conversation-1");
  try {
    compose(stack, ["up", "--build", "-d", "--wait"]);
    const event = messageEvent(address, `event-${mode}`);
    const options = effectOptions(
      `operation-${mode}`,
      `sha256:operation-${mode}`
    );
    const submitted = await request<PortResult<SessionReceipt>>(
      stack,
      "/runtime/submit",
      {
        agentVersion: 1,
        event,
        options,
      }
    );
    assert.equal(submitted.status, "ok");
    const stream = await waitFor(
      async () =>
        await request<PortResult<SessionStreamItem[]>>(
          stack,
          "/runtime/stream",
          { address }
        ),
      (result) =>
        result.status === "ok" &&
        result.value.some((item) => item.type === "approval"),
      120_000
    );
    assert.equal(stream.status, "ok");
    if (stream.status !== "ok") {
      return;
    }
    const approval = stream.value.find((item) => item.type === "approval");
    assert.ok(approval);
    const operationId = approval.approvalId.slice("approval:".length);
    const command = {
      address,
      approvalId: approval.approvalId,
      context: fixtureContext(address.organizationId),
      type: "approve",
    };
    const approvalOptions = effectOptions(
      `approve-${mode}`,
      `sha256:approve-${mode}`
    );
    const accepted = await request<PortResult<RunState>>(
      stack,
      "/runtime/approve",
      { command, options: approvalOptions }
    );
    assert.equal(accepted.status, "ok");
    const replay = await request<PortResult<RunState>>(
      stack,
      "/runtime/approve",
      { command, options: approvalOptions }
    );
    assert.deepEqual(replay, accepted);
    const effectUrl = `http://127.0.0.1:${stack.fixturePort}/effects/${encodeURIComponent(operationId)}`;
    await waitFor(
      async () => {
        const response = await fetch(effectUrl);
        return (await response.json()) as EffectRecord;
      },
      (record) => record.effects === 1 && record.held,
      60_000
    );

    compose(stack, ["kill", "-s", "SIGKILL", "celld"]);
    const beforeRestart = await getFixture<EffectRecord>(
      stack,
      `/effects/${encodeURIComponent(operationId)}`
    );
    assert.equal(beforeRestart.effects, 1);
    await releaseEffect(stack, operationId);
    compose(stack, ["up", "-d", "--wait", "celld"]);
    const expected = mode === "idempotent" ? "completed" : "unknown-outcome";
    const final = await waitFor(
      async () =>
        await request<PortResult<SessionSnapshot>>(stack, "/runtime/inspect", {
          address,
        }),
      (result) =>
        result.status === "ok" && result.value.runs[0]?.state === expected,
      340_000
    );
    assert.equal(final.status, "ok");
    const afterRestart = await getFixture<EffectRecord>(
      stack,
      `/effects/${encodeURIComponent(operationId)}`
    );
    assert.equal(afterRestart.effects, 1);
    assert.equal(afterRestart.calls, mode === "idempotent" ? 2 : 1);
    const replayedStream = await request<PortResult<SessionStreamItem[]>>(
      stack,
      "/runtime/stream",
      {
        address,
        cursor: approval.cursor,
      }
    );
    assert.equal(replayedStream.status, "ok");
    if (replayedStream.status === "ok") {
      assert.equal(
        replayedStream.value.some(
          (item) => item.type === "run" && item.run.state === expected
        ),
        true
      );
    }
  } finally {
    compose(stack, ["down", "-v"]);
  }
};

test(
  "an idempotent effect returns its stored provider result after SIGKILL",
  { timeout: 600_000 },
  async () => {
    await runCrashCase("idempotent", 0);
  }
);

test(
  "an uncertain non-idempotent effect enters reconciliation without a retry",
  { timeout: 600_000 },
  async () => {
    await runCrashCase("non-idempotent", 20);
  }
);
