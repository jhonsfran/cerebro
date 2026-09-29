import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyEventDelivery } from "../../packages/contracts/src/events.ts";
import {
  id,
  isExecutionContextActiveAt,
} from "../../packages/contracts/src/identity.ts";
import {
  classifyRetry,
  preflightEffect,
} from "../../packages/contracts/src/port.ts";
import {
  allowedContext,
  deniedContext,
  duplicateEvent,
  expiredDelegationContext,
  fixtureOrganizationId,
  unknownOutcomeInvocation,
  userEvent,
} from "../../packages/contracts/src/testing/fixtures.ts";
import { approvalMatches } from "../../packages/contracts/src/tools.ts";
import type { Approval } from "../../packages/contracts/src/tools.ts";

test("a disabled principal and an expired delegation cannot enter a session", () => {
  assert.equal(
    isExecutionContextActiveAt(
      allowedContext,
      fixtureOrganizationId,
      1_800_000_000_000
    ),
    true
  );
  assert.equal(
    isExecutionContextActiveAt(
      deniedContext,
      fixtureOrganizationId,
      1_800_000_000_000
    ),
    false
  );
  assert.equal(
    isExecutionContextActiveAt(
      expiredDelegationContext,
      fixtureOrganizationId,
      1_800_000_000_000
    ),
    false
  );
  assert.equal(
    isExecutionContextActiveAt(
      allowedContext,
      id.organization("another-organization"),
      1_800_000_000_000
    ),
    false
  );
});

test("the inbox detects duplicate delivery and rejects changed payloads", () => {
  assert.equal(classifyEventDelivery(userEvent, duplicateEvent), "duplicate");
  assert.equal(
    classifyEventDelivery(userEvent, {
      ...duplicateEvent,
      payloadDigest: id.digest("sha256:changed-message"),
    }),
    "conflict"
  );
  assert.equal(
    classifyEventDelivery(userEvent, {
      ...duplicateEvent,
      organizationId: id.organization("another-organization"),
    }),
    "conflict"
  );
  assert.equal(
    classifyEventDelivery(userEvent, {
      ...duplicateEvent,
      eventId: id.event("event-2"),
    }),
    "new"
  );
});

test("one operation ID cannot be reused with different arguments", () => {
  const options = {
    deadlineAt: 1_800_000_000_100,
    operationId: unknownOutcomeInvocation.operationId,
    requestDigest: unknownOutcomeInvocation.argumentDigest,
  };
  assert.equal(classifyRetry(options, options), "duplicate");
  assert.equal(
    classifyRetry(options, {
      ...options,
      requestDigest: id.digest("sha256:different"),
    }),
    "conflict"
  );
  assert.equal(
    classifyRetry(options, {
      ...options,
      operationId: id.operation("intentional-second-call"),
    }),
    "new"
  );
});

test("a past deadline and a cancelled signal stop a new effect", () => {
  const operationId = id.operation("effect-1");
  const requestDigest = id.digest("sha256:effect-1");
  const deadlineAt = 200;
  assert.deepEqual(
    preflightEffect({ deadlineAt, operationId, requestDigest }, 100),
    {
      status: "ok",
      value: undefined,
    }
  );
  assert.deepEqual(
    preflightEffect({ deadlineAt, operationId, requestDigest }, 200),
    {
      code: "deadline-exceeded",
      reason: "The operation deadline has passed.",
      status: "unavailable",
    }
  );
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    preflightEffect(
      { deadlineAt: Number.NaN, operationId, requestDigest },
      100
    ),
    {
      code: "deadline-exceeded",
      reason: "The operation deadline has passed.",
      status: "unavailable",
    }
  );
  assert.deepEqual(
    preflightEffect(
      { deadlineAt, operationId, requestDigest, signal: controller.signal },
      100
    ),
    {
      code: "cancelled",
      reason: "The caller cancelled the operation.",
      status: "unavailable",
    }
  );
});

test("approval binds the exact tool, arguments, principal, policy, and expiry", () => {
  const approval: Approval = {
    approverId: id.principal("approver-1"),
    argumentDigest: unknownOutcomeInvocation.argumentDigest,
    expiresAt: 300,
    id: "approval-1",
    operationId: unknownOutcomeInvocation.operationId,
    organizationId: unknownOutcomeInvocation.organizationId,
    policyVersion: "policy-1",
    principalId: allowedContext.actor.id,
    toolId: unknownOutcomeInvocation.tool.id,
    toolVersion: unknownOutcomeInvocation.tool.version,
  };
  assert.equal(
    approvalMatches(approval, unknownOutcomeInvocation, "policy-1", 299),
    true
  );
  assert.equal(
    approvalMatches(
      { ...approval, expiresAt: 1_900_000_000_000 },
      { ...unknownOutcomeInvocation, context: expiredDelegationContext },
      "policy-1",
      1_800_000_000_000
    ),
    false
  );
  assert.equal(
    approvalMatches(approval, unknownOutcomeInvocation, "policy-2", 299),
    false
  );
  assert.equal(
    approvalMatches(approval, unknownOutcomeInvocation, "policy-1", 300),
    false
  );
  assert.equal(
    approvalMatches(
      approval,
      {
        ...unknownOutcomeInvocation,
        argumentDigest: id.digest("sha256:changed"),
      },
      "policy-1",
      299
    ),
    false
  );
  assert.equal(
    approvalMatches(
      approval,
      {
        ...unknownOutcomeInvocation,
        tool: { ...unknownOutcomeInvocation.tool, version: "2" },
      },
      "policy-1",
      299
    ),
    false
  );
});
