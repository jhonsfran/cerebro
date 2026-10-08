/* oxlint-disable unicorn/no-await-expression-member -- Assertions use the preceding native response. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  addressFor,
  approve,
  boot,
  compose,
  effectOptions,
  evidence,
  getFixture,
  inspect,
  messageEvent,
  newStack,
  observe,
  pending,
  rawRequest,
  request,
  submit,
  waitFor,
} from "./helpers.ts";
import type { ProviderEvidence, Stack } from "./helpers.ts";

let stack: Stack;
let failed = false;
const companyA = addressFor("company-a", "conversation-1");
const companyB = addressFor("company-b", "conversation-1");
before(async () => {
  stack = await newStack("isolation");
  boot(stack);
});
after(async () => {
  if (failed) {
    await evidence(stack, "failure", {
      logs: compose(stack, [
        "logs",
        "--no-color",
        "--tail=100",
        "celld",
        "bootstrap",
      ]),
    });
  } else {
    compose(stack, ["down", "-v"]);
  }
});
const hostTest = (name: string, run: () => Promise<void>) =>
  test(name, async () => {
    try {
      await run();
    } catch (error) {
      failed = true;
      throw error;
    }
  });

hostTest(
  "native duplicate admission and changed event conflict remain local to one company",
  async () => {
    const event = messageEvent(companyA, "event-a");
    const first = await submit(stack, event, "operation-a");
    const replay = await submit(stack, event, "operation-a");
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.runId, first.runId);
    const changed = await rawRequest(stack, "/runtime/submit", {
      address: companyA,
      command: {
        event: {
          ...event,
          event: { payload: { text: "Changed" }, type: "user.message" },
        },
        mode: "follow-up",
        type: "submit",
      },
      options: effectOptions("operation-a"),
    });
    assert.equal(changed.status, 409);
    const changedMode = await rawRequest(stack, "/runtime/submit", {
      address: companyA,
      command: { event, mode: "steer", type: "submit" },
      options: effectOptions("operation-a"),
    });
    assert.equal(changedMode.status, 409);
    await submit(stack, messageEvent(companyB, "event-b"), "operation-b");
    const left = await inspect(stack, companyA);
    const right = await inspect(stack, companyB);
    assert.equal(left.runs.length, 1);
    assert.equal(right.runs.length, 1);
    assert.equal(left.address.organizationId, "company-a");
    assert.equal(right.address.organizationId, "company-b");
    assert.notEqual(left.runs[0]?.runId, right.runs[0]?.runId);
    const outsider = await rawRequest(
      stack,
      "/runtime/inspect",
      { address: companyA, options: effectOptions("outsider") },
      "user:company-b"
    );
    assert.equal(outsider.status, 403);
    await evidence(stack, "admission", { first, left, replay, right });
  }
);

hostTest(
  "observer detach does not Stop and reattach has a new epoch",
  async () => {
    const approval = await pending(stack, companyA);
    const first = await observe(stack, companyA);
    const initial = await first.next();
    assert.equal(initial.type, "snapshot");
    await first.close();
    assert.equal(
      (await inspect(stack, companyA)).runs[0]?.state,
      "waiting-for-approval"
    );
    const second = await observe(stack, companyA);
    const attached = await second.next();
    assert.notEqual(attached.epoch, initial.epoch);
    await second.close();
    await approve(stack, companyA, approval);
    const completed = await waitFor(
      () => inspect(stack, companyA),
      (value) => value.runs[0]?.state === "completed"
    );
    assert.equal(completed.outputs.length, 1);
    const provider = await getFixture<ProviderEvidence>(stack);
    assert.equal(
      provider.tools.filter((tool) => tool.operationId === approval.operationId)
        .length,
      1
    );
    await evidence(stack, "observation", {
      attached,
      completed,
      initial,
      provider,
    });
  }
);

hostTest(
  "current fixture access applies to domain history and receipts after restart",
  async () => {
    const saved = await inspect(stack, companyA);
    const operationId = saved.tools[0]?.operationId;
    assert.ok(operationId);
    const receipt = await request(stack, "/runtime/fixture/receipt", {
      address: companyA,
      operationId,
    });
    await request(stack, "/runtime/fixture/access", {
      address: companyA,
      enabled: false,
    });
    compose(stack, ["kill", "-s", "SIGKILL", "celld"]);
    compose(stack, ["up", "-d", "--wait", "celld"]);
    assert.equal(
      (
        await rawRequest(stack, "/runtime/inspect", {
          address: companyA,
          options: effectOptions("revoked-history"),
        })
      ).status,
      403
    );
    assert.equal(
      (
        await rawRequest(stack, "/runtime/fixture/receipt", {
          address: companyA,
          operationId,
        })
      ).status,
      403
    );
    await request(stack, "/runtime/fixture/access", {
      address: companyA,
      enabled: true,
    });
    const reopened = await inspect(stack, companyA);
    assert.deepEqual(reopened.outputs, saved.outputs);
    assert.deepEqual(reopened.userMessages, saved.userMessages);
    await request(stack, "/runtime/fixture/replay", {
      address: companyA,
      operationId,
    });
    assert.deepEqual(
      await request(stack, "/runtime/fixture/receipt", {
        address: companyA,
        operationId,
      }),
      receipt
    );
    await evidence(stack, "current-access", { receipt, reopened, saved });
  }
);

hostTest(
  "the independent PostgreSQL audit sink stores a repeated event once",
  async () => {
    const response = await fetch(
      `http://127.0.0.1:${stack.apiPort}/audit/replay`,
      {
        body: JSON.stringify({
          agentId: "agent-1",
          eventId: "projection-duplicate",
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
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { statuses: [200, 200] });
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
      "select count(*) from cerebro_audit_event where event_id='projection-duplicate'",
    ]);
    assert.equal(Number(count.trim()), 1);
  }
);
