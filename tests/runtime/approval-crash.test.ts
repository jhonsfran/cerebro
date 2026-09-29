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
  agentFor,
  compose,
  effectOptions,
  fixtureContext,
  getFixture,
  messageEvent,
  request,
  waitFor,
} from "./helpers.ts";

test(
  "approval request and waiting state survive SIGKILL before authorization",
  { timeout: 360_000 },
  async () => {
    const stack = {
      apiPort: 18_915,
      fixturePort: 18_916,
      holdAfterEffect: false,
      project: "cerebro-runtime-approval-crash",
    } as const;
    const address = addressFor("company-approval-crash", "conversation-1");
    try {
      compose(stack, ["up", "--build", "-d", "--wait"]);
      const submitted = await request<PortResult<SessionReceipt>>(
        stack,
        "/runtime/submit",
        {
          agent: agentFor(address, 1),
          event: messageEvent(address, "event-approval-crash"),
          options: effectOptions(
            "operation-approval-crash",
            "sha256:operation-approval-crash"
          ),
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
      compose(stack, ["kill", "-s", "SIGKILL", "celld"]);
      compose(stack, ["up", "-d", "--wait", "celld"]);
      const snapshot = await waitFor(
        async () =>
          await request<PortResult<SessionSnapshot>>(
            stack,
            "/runtime/inspect",
            { address }
          ),
        (result) =>
          result.status === "ok" &&
          result.value.runs[0]?.state === "waiting-for-approval",
        60_000
      );
      assert.equal(snapshot.status, "ok");
      if (snapshot.status === "ok") {
        assert.equal(snapshot.value.runs[0]?.state, "waiting-for-approval");
      }
      const operationId = approval.approvalId.slice("approval:".length);
      const effect = await fetch(
        `http://127.0.0.1:${stack.fixturePort}/effects/${encodeURIComponent(operationId)}`
      );
      assert.equal(effect.status, 404);
      const accepted = await request<PortResult<RunState>>(
        stack,
        "/runtime/approve",
        {
          command: {
            address,
            approvalId: approval.approvalId,
            context: fixtureContext(address.organizationId),
            type: "approve",
          },
          options: effectOptions(
            "approve-approval-crash",
            "sha256:approve-approval-crash"
          ),
        }
      );
      assert.equal(accepted.status, "ok");
      const final = await waitFor(
        async () =>
          await request<PortResult<SessionSnapshot>>(
            stack,
            "/runtime/inspect",
            { address }
          ),
        (result) =>
          result.status === "ok" && result.value.runs[0]?.state === "completed",
        180_000
      );
      assert.equal(final.status, "ok");
      const record = await getFixture<{ calls: number; effects: number }>(
        stack,
        `/effects/${encodeURIComponent(operationId)}`
      );
      assert.equal(record.calls, 1);
      assert.equal(record.effects, 1);
    } finally {
      compose(stack, ["down", "-v"]);
    }
  }
);
