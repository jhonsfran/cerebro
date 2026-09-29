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
import { createFixtureAdapters } from "../../packages/contracts/src/testing/adapters.ts";
import {
  activeDeniedContext,
  allowedContext,
  deniedContext,
  duplicateEvent,
  expiredDelegationContext,
  fixtureAgentId,
  fixtureOrganizationId,
  unknownOutcomeCapability,
  unknownOutcomeInvocation,
  userEvent,
} from "../../packages/contracts/src/testing/fixtures.ts";
import {
  approvalMatches,
  toolCapabilityMatches,
} from "../../packages/contracts/src/tools.ts";
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
      context: activeDeniedContext,
    }),
    "conflict"
  );
  assert.equal(
    classifyEventDelivery(userEvent, {
      ...duplicateEvent,
      event: {
        payload: { task: "Summarize the support issue." },
        type: "scheduled.run",
      },
    }),
    "conflict"
  );
  assert.equal(
    classifyEventDelivery(userEvent, {
      ...duplicateEvent,
      occurredAt: duplicateEvent.occurredAt + 1,
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

test("a capability cannot authorize a different tool invocation", () => {
  const effect = {
    deadlineAt: 1_900_000_000_000,
    operationId: unknownOutcomeInvocation.operationId,
    requestDigest: unknownOutcomeInvocation.argumentDigest,
  };
  assert.equal(
    toolCapabilityMatches(
      unknownOutcomeCapability,
      unknownOutcomeInvocation,
      effect,
      1_800_000_000_000
    ),
    true
  );
  assert.equal(
    toolCapabilityMatches(
      { ...unknownOutcomeCapability, toolVersion: "2" },
      unknownOutcomeInvocation,
      effect,
      1_800_000_000_000
    ),
    false
  );
  assert.equal(
    toolCapabilityMatches(
      {
        ...unknownOutcomeCapability,
        operationId: id.operation("another-effect"),
      },
      unknownOutcomeInvocation,
      effect,
      1_800_000_000_000
    ),
    false
  );
  assert.equal(
    toolCapabilityMatches(
      {
        ...unknownOutcomeCapability,
        principalId: id.principal("another-user"),
      },
      unknownOutcomeInvocation,
      effect,
      1_800_000_000_000
    ),
    false
  );
});

test("fixture policy denies an active principal without a grant", async () => {
  const ports = createFixtureAdapters({ mode: "fixture" });
  const resource = {
    id: "tool-1",
    kind: "tool" as const,
    organizationId: fixtureOrganizationId,
  };
  const readOptions = { deadlineAt: 1_900_000_000_000 };
  assert.deepEqual(
    await ports.authorizationPolicy.evaluate(
      activeDeniedContext,
      "execute",
      resource,
      readOptions
    ),
    {
      status: "ok",
      value: {
        decision: "deny",
        policyVersion: "fixture-v1",
        reason: "The principal has no current grant.",
      },
    }
  );
  assert.deepEqual(
    await ports.authorizationPolicy.evaluate(
      allowedContext,
      "execute",
      resource,
      readOptions
    ),
    { status: "ok", value: { decision: "allow", policyVersion: "fixture-v1" } }
  );
});

test("fixture budget denies depleted capacity and preserves retry outcome", async () => {
  const ports = createFixtureAdapters({ budgetUnits: 0, mode: "fixture" });
  const effect = {
    deadlineAt: 1_900_000_000_000,
    operationId: id.operation("reservation-request-1"),
    requestDigest: id.digest("sha256:one-credit"),
  };
  const request = { unit: "credits", units: 1 };
  const first = await ports.budgetAuthority.reserve(
    fixtureOrganizationId,
    request,
    effect
  );
  assert.deepEqual(first, {
    code: "budget-exhausted",
    reason: "No capacity remains for this organization.",
    status: "denied",
  });
  assert.deepEqual(
    await ports.budgetAuthority.reserve(fixtureOrganizationId, request, effect),
    first
  );
  assert.deepEqual(
    await ports.budgetAuthority.reserve(fixtureOrganizationId, request, {
      ...effect,
      requestDigest: id.digest("sha256:changed-reservation"),
    }),
    {
      code: "digest-mismatch",
      reason: "The operation ID already has a different request.",
      status: "conflict",
    }
  );
});

test("fixture session accepts one event and replays duplicate delivery", async () => {
  const ports = createFixtureAdapters({ mode: "fixture" });
  const effect = {
    deadlineAt: 1_900_000_000_000,
    operationId: id.operation("submit-1"),
    requestDigest: userEvent.payloadDigest,
  };
  const first = await ports.sessionService.submit(
    { event: userEvent, type: "submit" },
    effect
  );
  assert.equal(first.status, "ok");
  if (first.status !== "ok") {
    return;
  }
  assert.equal(first.value.replayed, false);
  assert.equal(first.value.runId, "run:event-1");
  const second = await ports.sessionService.submit(
    { event: duplicateEvent, type: "submit" },
    effect
  );
  assert.equal(second.status, "ok");
  if (second.status !== "ok") {
    return;
  }
  assert.equal(second.value.replayed, true);
  assert.equal(second.value.runId, first.value.runId);
  assert.deepEqual(
    await ports.sessionService.submit(
      {
        event: { ...duplicateEvent, context: activeDeniedContext },
        type: "submit",
      },
      effect
    ),
    {
      code: "unauthorized",
      reason: "The principal has no current grant.",
      status: "denied",
    }
  );
});

test("fixture tool reports an unknown outcome without a second effect", async () => {
  const ports = createFixtureAdapters({ mode: "fixture" });
  const effect = {
    deadlineAt: 1_900_000_000_000,
    operationId: unknownOutcomeInvocation.operationId,
    requestDigest: unknownOutcomeInvocation.argumentDigest,
  };
  const first = await ports.toolExecutor.execute(
    unknownOutcomeInvocation,
    unknownOutcomeCapability,
    effect
  );
  assert.deepEqual(first, {
    operationId: unknownOutcomeInvocation.operationId,
    reason:
      "The provider may have completed the effect before the connection failed.",
    status: "unknown-outcome",
  });
  assert.deepEqual(
    await ports.toolExecutor.execute(
      unknownOutcomeInvocation,
      unknownOutcomeCapability,
      effect
    ),
    first
  );
  assert.deepEqual(
    await ports.toolExecutor.reconcile(
      unknownOutcomeInvocation.operationId,
      allowedContext,
      { deadlineAt: 1_900_000_000_000 }
    ),
    first
  );
});

test("fixture adapters reject production mode", () => {
  assert.throws(
    () => createFixtureAdapters({ mode: "production" }),
    /Fixture adapters cannot run in production mode/u
  );
});

test("agent repository reads a pinned version after a new version is published", async () => {
  const { agentRepository } = createFixtureAdapters({ mode: "fixture" });
  const readOptions = { deadlineAt: 1_900_000_000_000 };
  const first = await agentRepository.get(
    fixtureOrganizationId,
    fixtureAgentId,
    1,
    readOptions
  );
  assert.equal(first.status, "ok");
  if (first.status !== "ok") {
    return;
  }
  assert.equal(first.value.model, "fixture-model");
  assert.equal(first.value.grants[0]?.action, "execute");

  const published = await agentRepository.publish(
    { ...first.value, model: "fixture-model-2", version: 2 },
    1,
    {
      deadlineAt: 1_900_000_000_000,
      operationId: id.operation("publish-agent-2"),
      requestDigest: id.digest("sha256:agent-v2"),
    }
  );
  assert.equal(published.status, "ok");
  const pinned = await agentRepository.get(
    fixtureOrganizationId,
    fixtureAgentId,
    1,
    readOptions
  );
  const latest = await agentRepository.get(
    fixtureOrganizationId,
    fixtureAgentId,
    "latest",
    readOptions
  );
  assert.equal(pinned.status, "ok");
  assert.equal(latest.status, "ok");
  if (pinned.status !== "ok" || latest.status !== "ok") {
    return;
  }
  assert.equal(pinned.value.model, "fixture-model");
  assert.equal(latest.value.model, "fixture-model-2");
  assert.deepEqual(
    await agentRepository.get(
      fixtureOrganizationId,
      fixtureAgentId,
      99,
      readOptions
    ),
    { resource: "agent version", status: "not-found" }
  );
});

test("fixture approval replays and a final run cannot be cancelled", async () => {
  const { sessionService } = createFixtureAdapters({
    mode: "fixture",
    pauseOnSubmit: true,
  });
  const submitted = await sessionService.submit(
    { event: userEvent, type: "submit" },
    {
      deadlineAt: 1_900_000_000_000,
      operationId: id.operation("submit-pending"),
      requestDigest: userEvent.payloadDigest,
    }
  );
  assert.equal(submitted.status, "ok");
  if (submitted.status !== "ok") {
    return;
  }
  const approval = {
    address: userEvent,
    approvalId: `approval:${submitted.value.runId}`,
    context: allowedContext,
    type: "approve" as const,
  };
  const effect = {
    deadlineAt: 1_900_000_000_000,
    operationId: id.operation("approve-pending"),
    requestDigest: id.digest("sha256:approval"),
  };
  const first = await sessionService.approve(approval, effect);
  assert.deepEqual(first, {
    status: "ok",
    value: {
      completedAt: 1_800_000_000_000,
      runId: submitted.value.runId,
      state: "completed",
    },
  });
  assert.deepEqual(await sessionService.approve(approval, effect), first);
  assert.deepEqual(
    await sessionService.cancel(
      {
        address: userEvent,
        context: allowedContext,
        runId: submitted.value.runId,
        type: "cancel",
      },
      {
        deadlineAt: 1_900_000_000_000,
        operationId: id.operation("cancel-completed"),
        requestDigest: id.digest("sha256:cancel-completed"),
      }
    ),
    { code: "already-final", reason: "The run is final.", status: "conflict" }
  );
});

test("fixture session inspection excludes another session's run", async () => {
  const { sessionService } = createFixtureAdapters({ mode: "fixture" });
  const secondEvent = {
    ...userEvent,
    eventId: id.event("event-other-session"),
    sessionId: id.session("session-other"),
  };
  const first = await sessionService.submit(
    { event: userEvent, type: "submit" },
    {
      deadlineAt: 1_900_000_000_000,
      operationId: id.operation("submit-first-session"),
      requestDigest: userEvent.payloadDigest,
    }
  );
  assert.equal(first.status, "ok");
  const second = await sessionService.submit(
    { event: secondEvent, type: "submit" },
    {
      deadlineAt: 1_900_000_000_000,
      operationId: id.operation("submit-other-session"),
      requestDigest: id.digest("sha256:other-session"),
    }
  );
  assert.equal(second.status, "ok");
  const inspected = await sessionService.inspect(userEvent, allowedContext, {
    deadlineAt: 1_900_000_000_000,
  });
  assert.equal(inspected.status, "ok");
  if (inspected.status !== "ok") {
    return;
  }
  assert.deepEqual(
    inspected.value.runs.map((run) => run.runId),
    ["run:event-1"]
  );
  assert.equal(inspected.value.cursor, "1");
  const streamed = [];
  for await (const item of sessionService.stream(
    userEvent,
    allowedContext,
    undefined,
    {
      deadlineAt: 1_900_000_000_000,
    }
  )) {
    streamed.push(item);
  }
  assert.deepEqual(streamed, [
    {
      status: "ok",
      value: {
        cursor: "1",
        run: { runId: "run:event-1", state: "queued" },
        type: "run",
      },
    },
  ]);
  const resumed = [];
  for await (const item of sessionService.stream(
    userEvent,
    allowedContext,
    "1",
    {
      deadlineAt: 1_900_000_000_000,
    }
  )) {
    resumed.push(item);
  }
  assert.deepEqual(resumed, []);
});
