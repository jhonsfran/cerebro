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
  "two intentional Pi calls with equal arguments retain separate occurrence identities",
  { timeout: 360_000 },
  async () => {
    const stack = await newStack("occurrence");
    const address = addressFor("company-occurrence", "conversation-1");
    let passed = false;
    try {
      boot(stack);
      const firstEvent = messageEvent(address, "first-occurrence");
      const first = await submit(stack, firstEvent);
      const firstApproval = await pending(stack, address);
      await approve(stack, address, firstApproval);
      await waitFor(
        () => inspect(stack, address),
        (value) => value.runs[0]?.state === "completed"
      );
      const second = await submit(
        stack,
        messageEvent(address, "second-occurrence")
      );
      const secondApproval = await pending(stack, address);
      assert.notEqual(secondApproval.operationId, firstApproval.operationId);
      await approve(stack, address, secondApproval);
      const completed = await waitFor(
        () => inspect(stack, address),
        (value) => value.runs.every((run) => run.state === "completed")
      );
      assert.equal(completed.tools.length, 2);
      assert.deepEqual(
        completed.tools[0]?.arguments,
        completed.tools[1]?.arguments
      );
      const replay = await submit(stack, firstEvent);
      assert.equal(replay.runId, first.runId);
      assert.equal(replay.replayed, true);
      const provider = await getFixture<ProviderEvidence>(stack);
      assert.equal(
        provider.tools.filter(
          (tool) =>
            tool.operationId === firstApproval.operationId ||
            tool.operationId === secondApproval.operationId
        ).length,
        2
      );
      await evidence(stack, "equal-occurrences", {
        completed,
        first,
        provider,
        replay,
        second,
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
