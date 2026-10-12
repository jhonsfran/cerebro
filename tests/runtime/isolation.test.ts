/* oxlint-disable unicorn/no-await-expression-member -- Assertions inspect the preceding native response. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  addressFor,
  boot,
  compose,
  evidence,
  newStack,
  rawRequest,
  read,
  request,
  send,
  waitFor,
} from "./helpers.ts";
import type { Stack } from "./helpers.ts";

let stack: Stack;
let failed = false;
const companyA = addressFor("company-a", "conversation-1");
const companyB = addressFor("company-b", "conversation-1");
before(
  async () => {
    stack = await newStack("isolation");
    boot(stack);
  },
  { timeout: 600_000 }
);
after(
  async () => {
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
    }
    compose(stack, ["down", "-v"]);
  },
  { timeout: 120_000 }
);
const hostTest = (name: string, run: () => Promise<void>) =>
  test(name, { timeout: 120_000 }, async () => {
    try {
      await run();
    } catch (error) {
      failed = true;
      throw error;
    }
  });

hostTest(
  "native inputs and snapshots remain local to one company and reject a foreign owner",
  async () => {
    await send(stack, companyA, "company-input", "Explain company A policy.");
    await send(stack, companyB, "company-input", "Explain company B policy.");
    const left = await waitFor(
      () => read(stack, companyA),
      (value) => !value.busy
    );
    const right = await waitFor(
      () => read(stack, companyB),
      (value) => !value.busy
    );
    assert.equal(left.address.organizationId, "company-a");
    assert.equal(right.address.organizationId, "company-b");
    assert.deepEqual(
      left.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      ["Explain company A policy."]
    );
    assert.deepEqual(
      right.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      ["Explain company B policy."]
    );
    assert.equal(
      (
        await rawRequest(
          stack,
          "/runtime/read",
          { address: companyA },
          "user:company-b"
        )
      ).status,
      403
    );
    await evidence(stack, "company-isolation", { left, right });
  }
);

hostTest(
  "current fixture access applies to native history after restart",
  async () => {
    const saved = await read(stack, companyA);
    await request(stack, "/runtime/fixture/access", {
      address: companyA,
      enabled: false,
    });
    compose(stack, ["kill", "-s", "SIGKILL", "celld"]);
    compose(stack, ["up", "-d", "--wait", "celld"]);
    assert.equal(
      (await rawRequest(stack, "/runtime/read", { address: companyA })).status,
      403
    );
    await request(stack, "/runtime/fixture/access", {
      address: companyA,
      enabled: true,
    });
    const reopened = await read(stack, companyA);
    assert.deepEqual(reopened.messages, saved.messages);
    await evidence(stack, "current-access", { reopened, saved });
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
