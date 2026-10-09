import assert from "node:assert/strict";
import { test } from "node:test";

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
  submit,
  waitFor,
} from "./helpers.ts";
import type { ProviderEvidence } from "./helpers.ts";

test(
  "a lost write response settles as an unknown tool outcome with one physical write",
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
      // The model receives an error result for the uncertain call and answers.
      const final = await waitFor(
        () => inspect(stack, address),
        (value) => value.runs[0]?.state === "completed"
      );
      assert.equal(final.tools[0]?.state, "unknown-outcome");
      assert.equal(final.outputs.length, 1);
      const replayed = await submit(stack, event);
      assert.equal(replayed.runId, submitted.runId);
      assert.equal(replayed.replayed, true);
      const provider = await getFixture<ProviderEvidence>(stack);
      assert.equal(
        provider.tools.filter(
          (tool) => tool.operationId === approval.operationId
        ).length,
        1
      );
      await evidence(stack, "lost-response", {
        final,
        provider,
        replayed,
        submitted,
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
