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
  "a transient provider response failure retries one idempotent operation",
  { timeout: 360_000 },
  async () => {
    const stack = {
      apiPort: 18_905,
      failFirstEffect: true,
      fixturePort: 18_906,
      holdAfterEffect: false,
      project: "cerebro-runtime-transient",
    } as const;
    const address = addressFor("company-transient", "conversation-1");
    try {
      compose(stack, ["up", "--build", "-d", "--wait"]);
      const submitted = await request<PortResult<SessionReceipt>>(
        stack,
        "/runtime/submit",
        {
          agent: agentFor(address, 1),
          event: messageEvent(address, "event-transient"),
          options: effectOptions(
            "operation-transient",
            "sha256:operation-transient"
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
            "approve-transient",
            "sha256:approve-transient"
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
        40_000
      ).catch(async (error: unknown) => {
        const events = await request<PortResult<SessionStreamItem[]>>(
          stack,
          "/runtime/stream",
          { address }
        );
        const provider = await getFixture<unknown>(
          stack,
          `/effects/${encodeURIComponent(approval.approvalId.slice("approval:".length))}`
        );
        throw new Error(
          `Transient run failed: ${JSON.stringify({ events, provider })}`,
          { cause: error }
        );
      });
      assert.equal(final.status, "ok");
      const operationId = approval.approvalId.slice("approval:".length);
      const record = await getFixture<{ calls: number; effects: number }>(
        stack,
        `/effects/${encodeURIComponent(operationId)}`
      );
      assert.equal(record.calls, 2);
      assert.equal(record.effects, 1);
    } finally {
      compose(stack, ["down", "-v"]);
    }
  }
);
