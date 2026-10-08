import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { ToolReceipt } from "../../packages/contracts/src/receipt-service.ts";
import {
  addressFor,
  approve,
  boot,
  compose,
  control,
  evidence,
  getFixture,
  inspect,
  messageEvent,
  newStack,
  pending,
  rawRequest,
  reconcile,
  request,
  submit,
  waitFor,
} from "./helpers.ts";
import type { ProviderEvidence } from "./helpers.ts";

interface LifecycleEvidence {
  readonly alarms: readonly { readonly at: number }[];
  readonly alarmAt: number | null;
  readonly jobs: readonly unknown[];
  readonly pending: readonly unknown[];
}

test(
  "a dispatched native write remains unknown across SIGKILL and reconciles without a second write",
  { timeout: 360_000 },
  async () => {
    const stack = await newStack("dispatch");
    const address = addressFor("company-dispatch", "conversation-1");
    let passed = false;
    try {
      boot(stack);
      await control(stack, {
        arm: { boundary: "after-tool-dispatch", id: "native-dispatch" },
      });
      await submit(stack, messageEvent(address, "dispatch-event"));
      const approval = await pending(stack, address);
      await approve(stack, address, approval);
      const dispatched = await waitFor(
        () => getFixture<ProviderEvidence>(stack),
        (value) =>
          value.held === 1 &&
          value.tools.some((tool) => tool.operationId === approval.operationId)
      );
      const durable = await request<ToolReceipt>(
        stack,
        "/runtime/fixture/receipt",
        { address, operationId: approval.operationId }
      );
      assert.equal(durable.state, "dispatched");
      const beforeLifecycle = await request<LifecycleEvidence>(
        stack,
        "/runtime/fixture/lifecycle",
        { address }
      );
      await evidence(stack, "before-kill", {
        approval,
        beforeLifecycle,
        dispatched,
        durable,
      });
      const killedAt = Date.now();
      compose(stack, ["kill", "-s", "SIGKILL", "celld"]);
      await control(stack, { arm: null, release: true });
      const restartedAt = Date.now();
      compose(stack, ["up", "-d", "--wait", "celld"]);
      // No native host request is made during the documented cold-cell discovery window.
      await delay(90_000);
      const firstReadAt = Date.now();
      const lifecycle = await request<LifecycleEvidence>(
        stack,
        "/runtime/fixture/lifecycle",
        { address }
      );
      await evidence(stack, "alarm-observation", {
        beforeLifecycle,
        firstReadAt,
        killedAt,
        lifecycle,
        restartedAt,
      });
      assert.ok(
        lifecycle.alarms.some(
          (alarm) => alarm.at >= restartedAt && alarm.at < firstReadAt
        ),
        "Official Lifecycle must run its alarm while every observer is closed"
      );
      const wakeAt = lifecycle.alarms.find(
        (alarm) => alarm.at >= restartedAt && alarm.at < firstReadAt
      )?.at;
      assert.ok(wakeAt);
      const wakeMs = wakeAt - restartedAt;
      await evidence(stack, "alarm-wake", {
        firstReadAt,
        lifecycle,
        meetsPerformanceBudget: wakeMs <= 60_000,
        restartedAt,
        wakeMs,
      });
      assert.ok(
        wakeMs <= 60_000,
        `Selected celld host must recover within 60 seconds; actual wake ${wakeMs} ms`
      );
      const unknown = await waitFor(
        () => inspect(stack, address),
        (value) => value.runs[0]?.state === "unknown-outcome",
        120_000
      );
      const blocked = await rawRequest(stack, "/runtime/submit", {
        address,
        command: {
          event: messageEvent(address, "blocked-event"),
          mode: "follow-up",
          type: "submit",
        },
        options: {
          deadlineAt: Date.now() + 60_000,
          operationId: "blocked-command",
          requestDigest: "sha256:blocked",
        },
      });
      assert.equal(blocked.status, 409);
      await request(stack, "/runtime/fixture/evidence", {
        address,
        enabled: false,
      });
      const unavailable = await rawRequest(stack, "/runtime/reconcile", {
        address,
        command: { operationId: approval.operationId, runId: approval.runId },
        options: {
          deadlineAt: Date.now() + 60_000,
          operationId: "unavailable-reconcile",
          requestDigest: "sha256:unavailable-reconcile",
        },
      });
      assert.equal(unavailable.status, 503);
      const repeated = await rawRequest(stack, "/runtime/fixture/occurrence", {
        address,
        operationId: approval.operationId,
        replacementOperationId: "new-uncertain-occurrence",
      });
      assert.equal(repeated.status, 409);
      await request(stack, "/runtime/fixture/evidence", {
        address,
        enabled: true,
      });
      const reconciled = await reconcile(stack, address, approval);
      const confirmed = await request<ToolReceipt>(
        stack,
        "/runtime/fixture/receipt",
        { address, operationId: approval.operationId }
      );
      assert.equal(confirmed.state, "completed");
      const final = await waitFor(
        () => inspect(stack, address),
        (value) => value.runs[0]?.state === "completed",
        120_000
      );
      assert.equal(final.tools[0]?.state, "succeeded");
      assert.equal(final.outputs.length, 1);
      const provider = await getFixture<ProviderEvidence>(stack);
      assert.equal(
        provider.tools.filter(
          (value) => value.operationId === approval.operationId
        ).length,
        1
      );
      await evidence(stack, "dispatch-restart", {
        approval,
        confirmed,
        dispatched,
        durable,
        final,
        firstReadAt,
        lifecycle,
        provider,
        reconciled,
        restartedAt,
        unknown,
      });
      passed = true;
    } finally {
      if (passed) {
        compose(stack, ["down", "-v"]);
      } else {
        await evidence(stack, "failure", {
          containers: compose(stack, ["ps", "--all", "--format", "json"]),
          logs: compose(stack, [
            "logs",
            "--no-color",
            "--tail=100",
            "celld",
            "bootstrap",
          ]),
        });
      }
    }
  }
);
