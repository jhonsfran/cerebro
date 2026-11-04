import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { EventAddress } from "../../packages/contracts/src/events.ts";
import type { ChatApproval } from "../../packages/contracts/src/session-service.ts";
import {
  addressFor,
  compose,
  decide,
  pending,
  read,
  request,
  send,
  waitFor,
} from "./helpers.ts";
import type { Stack } from "./helpers.ts";
import {
  completed,
  restart,
  runtimeJourney,
  writeCount,
} from "./runtime-journey.ts";

const organizationId = "company-audit";
const auditFixture = async (
  stack: Stack,
  address: EventAddress,
  fault: { fail?: string; hold?: string } = {}
): Promise<unknown[]> => {
  const value = await request(stack, "/runtime/fixture/audit", {
    address,
    ...fault,
  });
  assert.ok(Array.isArray(value));
  return value;
};
const storedEvents = (stack: Stack, operationId: string): unknown =>
  JSON.parse(
    compose(stack, [
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
      `select coalesce(json_agg(json_build_object('agentId', agent_id, 'eventId', event_id, 'kind', kind, 'name', name, 'organizationId', organization_id, 'payload', payload, 'runId', run_id, 'sessionId', session_id) order by occurred_at, name), '[]') from cerebro_audit_event where payload->>'operationId' = '${operationId.replaceAll("'", "''")}'`,
    ]).trim()
  );
const envelope = (
  address: EventAddress,
  approval: ChatApproval,
  name: "tool.dispatched" | "tool.settled"
) => ({
  agentId: "agent-1",
  eventId: `${approval.operationId}:${name}`,
  kind: "audit",
  name,
  organizationId,
  runId: approval.taskId,
  sessionId: address.sessionId,
});
const facts = (approval: ChatApproval) => ({
  actorPrincipalId: `user:${organizationId}`,
  approvalId: approval.approvalId,
  argumentDigest: `sha256:${createHash("sha256")
    .update(JSON.stringify(approval.arguments))
    .digest("hex")}`,
  connectorId: "fixture",
  delegationId: null,
  effect: "write",
  operationId: approval.operationId,
  policyVersion: "fixture-v1",
  representedPrincipalId: null,
  toolId: "fixture_effect",
  toolVersion: "1",
});

const journey = runtimeJourney("audit-journey");
journey(
  "an approved write that succeeds is stored as dispatched then settled, with only the argument digest",
  async (stack) => {
    const address = addressFor(organizationId, "audit-success");
    await send(stack, address, "audit-success", "Apply fixture_effect once.");
    const approval = await pending(stack, address);
    await decide(stack, address, approval);
    await waitFor(() => read(stack, address), completed);
    assert.deepEqual(storedEvents(stack, approval.operationId), [
      {
        ...envelope(address, approval, "tool.dispatched"),
        payload: facts(approval),
      },
      {
        ...envelope(address, approval, "tool.settled"),
        payload: { ...facts(approval), outcome: "succeeded", reason: null },
      },
    ]);
  }
);

journey(
  "a denied call is stored only as settled with outcome denied",
  async (stack) => {
    const address = addressFor(organizationId, "audit-denied");
    await send(stack, address, "audit-denied", "Apply fixture_effect once.");
    const approval = await pending(stack, address);
    await decide(stack, address, approval, "deny");
    await waitFor(() => read(stack, address), completed);
    assert.equal(await writeCount(stack, approval.operationId), 0);
    assert.deepEqual(storedEvents(stack, approval.operationId), [
      {
        ...envelope(address, approval, "tool.settled"),
        payload: {
          ...facts(approval),
          outcome: "denied",
          reason: "The tool approval was denied, cancelled, or expired.",
        },
      },
    ]);
  }
);

journey(
  "a dispatch that cannot be audited fails the call before the connector runs",
  async (stack) => {
    const address = addressFor(organizationId, "audit-closed");
    await send(stack, address, "audit-closed", "Apply fixture_effect once.");
    const approval = await pending(stack, address);
    await auditFixture(stack, address, { fail: "tool.dispatched" });
    await decide(stack, address, approval);
    const final = await waitFor(() => read(stack, address), completed);
    assert.equal(await writeCount(stack, approval.operationId), 0);
    assert.deepEqual(
      final.tools.map((tool) => [tool.state, tool.output]),
      [
        [
          "failed",
          "<harness>\n[error] The tool call could not be audited.\n</harness>",
        ],
      ]
    );
    assert.deepEqual(storedEvents(stack, approval.operationId), [
      {
        ...envelope(address, approval, "tool.settled"),
        payload: {
          ...facts(approval),
          outcome: "failed",
          reason: "The tool call could not be audited.",
        },
      },
    ]);
  }
);

journey(
  "a settlement that cannot be audited leaves the tool result unchanged",
  async (stack) => {
    const address = addressFor(organizationId, "audit-settle-down");
    await send(
      stack,
      address,
      "audit-settle-down",
      "Apply fixture_effect once."
    );
    const approval = await pending(stack, address);
    await auditFixture(stack, address, { fail: "tool.settled" });
    await decide(stack, address, approval);
    const final = await waitFor(() => read(stack, address), completed);
    assert.deepEqual(
      final.tools.map((tool) => [tool.state, JSON.parse(tool.output)]),
      [
        [
          "succeeded",
          {
            operationId: approval.operationId,
            receipt: `receipt:${approval.operationId}`,
            value: "approved-fixture",
          },
        ],
      ]
    );
    assert.deepEqual(storedEvents(stack, approval.operationId), [
      {
        ...envelope(address, approval, "tool.dispatched"),
        payload: facts(approval),
      },
    ]);
  }
);

journey(
  "a call replayed after a crash sends the same dispatched event and the sink keeps one",
  async (stack) => {
    const address = addressFor(organizationId, "audit-replay");
    await send(stack, address, "audit-replay", "Apply fixture_effect once.");
    const approval = await pending(stack, address);
    await auditFixture(stack, address, { hold: "tool.dispatched" });
    await decide(stack, address, approval);
    const [first] = await waitFor(
      () => auditFixture(stack, address),
      (events) => events.length === 1
    );
    assert.equal(await writeCount(stack, approval.operationId), 0);
    restart(stack);
    await waitFor(() => read(stack, address), completed);
    assert.equal(await writeCount(stack, approval.operationId), 1);
    const sent = await auditFixture(stack, address);
    assert.equal(sent.length, 3);
    assert.deepEqual(sent[1], first);
    assert.deepEqual(storedEvents(stack, approval.operationId), [
      {
        ...envelope(address, approval, "tool.dispatched"),
        payload: facts(approval),
      },
      {
        ...envelope(address, approval, "tool.settled"),
        payload: { ...facts(approval), outcome: "succeeded", reason: null },
      },
    ]);
  }
);
