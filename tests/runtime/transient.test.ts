import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolReceipt } from "../../packages/contracts/src/receipt-service.ts";
import {
  addressFor,
  approve,
  boot,
  compose,
  evidence,
  getFixture,
  inspect,
  messageEvent,
  newStack,
  pending,
  reconcile,
  request,
  submit,
  waitFor,
} from "./helpers.ts";
import type { ProviderEvidence } from "./helpers.ts";

test(
  "a lost write response requires receipt reconciliation and creates one physical write",
  { timeout: 360_000 },
  async () => {
    const stack = await newStack("lost-response", true);
    const address = addressFor("company-lost-response", "conversation-1");
    let passed = false;
    try {
      boot(stack);
      const event = messageEvent(address, "lost-response-event");
      const submitted = await submit(stack, event);
      const approval = await pending(stack, address);
      await approve(stack, address, approval);
      const snapshot = await waitFor(
        () => inspect(stack, address),
        (value) => value.runs[0]?.state === "unknown-outcome"
      );
      assert.equal(snapshot.outputs.length, 0);
      const replayed = await submit(stack, event);
      assert.equal(replayed.runId, submitted.runId);
      assert.equal(replayed.replayed, true);
      const unknown = await request<ToolReceipt>(
        stack,
        "/runtime/fixture/receipt",
        { address, operationId: approval.operationId }
      );
      assert.equal(unknown.state, "unknown");
      const reconciled = await reconcile(stack, address, approval);
      const confirmed = await request<ToolReceipt>(
        stack,
        "/runtime/fixture/receipt",
        { address, operationId: approval.operationId }
      );
      assert.equal(confirmed.state, "completed");
      const final = await waitFor(
        () => inspect(stack, address),
        (value) => value.runs[0]?.state === "completed"
      );
      assert.equal(final.tools[0]?.state, "succeeded");
      assert.equal(final.outputs.length, 1);
      const provider = await getFixture<ProviderEvidence>(stack);
      assert.equal(
        provider.tools.filter(
          (tool) => tool.operationId === approval.operationId
        ).length,
        1
      );
      await evidence(stack, "lost-response", {
        confirmed,
        final,
        provider,
        reconciled,
        replayed,
        snapshot,
        submitted,
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
