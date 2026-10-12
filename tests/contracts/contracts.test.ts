import assert from "node:assert/strict";
import { test } from "node:test";

import {
  id,
  isExecutionContextActiveAt,
} from "../../packages/contracts/src/identity.ts";
import {
  classifyRetry,
  preflightEffect,
} from "../../packages/contracts/src/port.ts";
import {
  approvalMatches,
  canonicalToolArguments,
  digestToolArguments,
  toolCapabilityMatches,
} from "../../packages/contracts/src/tools.ts";
import type { Approval } from "../../packages/contracts/src/tools.ts";
import { createFixtureAdapters } from "../support/adapters.ts";
import {
  activeDeniedContext,
  allowedContext,
  allowedUser,
  deniedContext,
  expiredDelegationContext,
  fixtureAgentId,
  fixtureOrganizationId,
  serviceActor,
  unknownOutcomeCapability,
  unknownOutcomeInvocation,
} from "../support/fixtures.ts";

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

test("approval binds the exact tool, arguments, principal, policy, and expiry", async () => {
  const approval: Approval = {
    actorPrincipalId: allowedUser.id,
    agentId: unknownOutcomeInvocation.agentId,
    approverId: id.principal("approver-1"),
    argumentDigest: unknownOutcomeInvocation.argumentDigest,
    connectorId: unknownOutcomeInvocation.tool.connectorId,
    effect: unknownOutcomeInvocation.tool.effect,
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
    await approvalMatches(approval, unknownOutcomeInvocation, "policy-1", 299),
    true
  );
  assert.equal(
    await approvalMatches(
      { ...approval, expiresAt: 1_900_000_000_000 },
      { ...unknownOutcomeInvocation, context: expiredDelegationContext },
      "policy-1",
      1_800_000_000_000
    ),
    false
  );
  assert.equal(
    await approvalMatches(approval, unknownOutcomeInvocation, "policy-2", 299),
    false
  );
  assert.equal(
    await approvalMatches(approval, unknownOutcomeInvocation, "policy-1", 300),
    false
  );
  assert.equal(
    await approvalMatches(
      { ...approval, expiresAt: Number.NaN },
      unknownOutcomeInvocation,
      "policy-1",
      299
    ),
    false
  );
  assert.equal(
    await approvalMatches(
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
    await approvalMatches(
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
  assert.equal(
    await approvalMatches(
      approval,
      { ...unknownOutcomeInvocation, agentId: id.agent("agent-2") },
      "policy-1",
      299
    ),
    false
  );
  assert.equal(
    await approvalMatches(
      approval,
      {
        ...unknownOutcomeInvocation,
        tool: { ...unknownOutcomeInvocation.tool, connectorId: "other" },
      },
      "policy-1",
      299
    ),
    false
  );
  assert.equal(
    await approvalMatches(
      approval,
      {
        ...unknownOutcomeInvocation,
        tool: { ...unknownOutcomeInvocation.tool, effect: "read" },
      },
      "policy-1",
      299
    ),
    false
  );
});

test("approval rejects changed arguments when the stored digest is reused", async () => {
  const approval = {
    actorPrincipalId: allowedUser.id,
    agentId: unknownOutcomeInvocation.agentId,
    approverId: id.principal("approver-1"),
    argumentDigest: unknownOutcomeInvocation.argumentDigest,
    connectorId: unknownOutcomeInvocation.tool.connectorId,
    effect: unknownOutcomeInvocation.tool.effect,
    expiresAt: 300,
    id: "approval-arguments",
    operationId: unknownOutcomeInvocation.operationId,
    organizationId: unknownOutcomeInvocation.organizationId,
    policyVersion: "policy-1",
    principalId: allowedUser.id,
    toolId: unknownOutcomeInvocation.tool.id,
    toolVersion: unknownOutcomeInvocation.tool.version,
  };
  assert.equal(
    await approvalMatches(
      approval,
      { ...unknownOutcomeInvocation, arguments: { ticket: "support-2" } },
      "policy-1",
      299
    ),
    false
  );
});

test("approval binds the delegated actor and delegation ID", async () => {
  const firstActor = serviceActor;
  const firstDelegation = {
    actorId: firstActor.id,
    expiresAt: 1_900_000_000_000,
    id: id.delegation("delegation-1"),
    organizationId: fixtureOrganizationId,
    representedId: allowedUser.id,
  };
  const approval = {
    actorPrincipalId: firstActor.id,
    agentId: unknownOutcomeInvocation.agentId,
    approverId: id.principal("approver-1"),
    argumentDigest: unknownOutcomeInvocation.argumentDigest,
    connectorId: unknownOutcomeInvocation.tool.connectorId,
    delegationId: firstDelegation.id,
    effect: unknownOutcomeInvocation.tool.effect,
    expiresAt: 1_900_000_000_000,
    id: "approval-delegation",
    operationId: unknownOutcomeInvocation.operationId,
    organizationId: unknownOutcomeInvocation.organizationId,
    policyVersion: "policy-1",
    principalId: allowedUser.id,
    toolId: unknownOutcomeInvocation.tool.id,
    toolVersion: unknownOutcomeInvocation.tool.version,
  };
  const firstInvocation = {
    ...unknownOutcomeInvocation,
    context: {
      actor: firstActor,
      delegation: firstDelegation,
      represented: allowedUser,
    },
  };
  assert.equal(
    await approvalMatches(
      approval,
      firstInvocation,
      "policy-1",
      1_800_000_000_000
    ),
    true
  );
  const secondActor = { ...serviceActor, id: id.principal("service-2") };
  const changedActor = {
    ...firstInvocation,
    context: {
      actor: secondActor,
      delegation: {
        ...firstDelegation,
        actorId: secondActor.id,
        id: id.delegation("delegation-2"),
      },
      represented: allowedUser,
    },
  };
  assert.equal(
    await approvalMatches(
      approval,
      changedActor,
      "policy-1",
      1_800_000_000_000
    ),
    false
  );
  assert.equal(
    await approvalMatches(
      approval,
      {
        ...firstInvocation,
        context: {
          ...firstInvocation.context,
          delegation: { ...firstDelegation, id: id.delegation("delegation-2") },
        },
      },
      "policy-1",
      1_800_000_000_000
    ),
    false
  );
});

test("a capability cannot authorize a different tool invocation", async () => {
  assert.equal(
    await toolCapabilityMatches(
      { ...unknownOutcomeCapability, expiresAt: Number.NaN },
      unknownOutcomeInvocation,
      {
        deadlineAt: 1_900_000_000_000,
        operationId: unknownOutcomeInvocation.operationId,
        requestDigest: unknownOutcomeInvocation.argumentDigest,
      },
      1_800_000_000_000
    ),
    false
  );
  const effect = {
    deadlineAt: 1_900_000_000_000,
    operationId: unknownOutcomeInvocation.operationId,
    requestDigest: unknownOutcomeInvocation.argumentDigest,
  };
  assert.equal(
    await toolCapabilityMatches(
      unknownOutcomeCapability,
      unknownOutcomeInvocation,
      effect,
      1_800_000_000_000
    ),
    true
  );
  assert.equal(
    await toolCapabilityMatches(
      { ...unknownOutcomeCapability, toolVersion: "2" },
      unknownOutcomeInvocation,
      effect,
      1_800_000_000_000
    ),
    false
  );
  assert.equal(
    await toolCapabilityMatches(
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
    await toolCapabilityMatches(
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

test("fixture tool rejects changed arguments even when the caller reuses a digest", async () => {
  const { toolExecutor } = createFixtureAdapters({ mode: "fixture" });
  const effect = {
    deadlineAt: 1_900_000_000_000,
    operationId: unknownOutcomeInvocation.operationId,
    requestDigest: unknownOutcomeInvocation.argumentDigest,
  };
  const changedCall = {
    ...unknownOutcomeInvocation,
    arguments: { ticket: "support-2" },
  };
  assert.deepEqual(
    await toolExecutor.execute(changedCall, unknownOutcomeCapability, effect),
    {
      code: "unauthorized",
      reason: "The tool capability does not authorize this call.",
      status: "denied",
    }
  );
});

test("a delegated capability binds the actor as well as the represented user", async () => {
  const delegationId = id.delegation("delegation-active");
  const delegatedCall = {
    ...unknownOutcomeInvocation,
    context: {
      actor: serviceActor,
      delegation: {
        actorId: serviceActor.id,
        expiresAt: 1_900_000_000_000,
        id: delegationId,
        organizationId: fixtureOrganizationId,
        representedId: allowedUser.id,
      },
      represented: allowedUser,
    },
  };
  const capability = {
    ...unknownOutcomeCapability,
    actorPrincipalId: serviceActor.id,
    delegationId,
  };
  const effect = {
    deadlineAt: 1_900_000_000_000,
    operationId: unknownOutcomeInvocation.operationId,
    requestDigest: unknownOutcomeInvocation.argumentDigest,
  };
  assert.equal(
    await toolCapabilityMatches(
      capability,
      delegatedCall,
      effect,
      1_800_000_000_000
    ),
    true
  );
  const otherActor = { ...serviceActor, id: id.principal("service-other") };
  const changedActorCall = {
    ...delegatedCall,
    context: {
      ...delegatedCall.context,
      actor: otherActor,
      delegation: {
        ...delegatedCall.context.delegation,
        actorId: otherActor.id,
      },
    },
  };
  assert.equal(
    await toolCapabilityMatches(
      capability,
      changedActorCall,
      effect,
      1_800_000_000_000
    ),
    false
  );
});

test("grant-scoped memory follows current fixture grants", async () => {
  const grants = new Map([[allowedUser.id, new Set(["support-source-read"])]]);
  const fixtureOptions = {
    grantIdsByPrincipal: grants,
    mode: "fixture" as const,
  };
  const { memoryStore } = createFixtureAdapters(fixtureOptions);
  const record = {
    id: "memory-granted",
    kind: "source-chunk" as const,
    provenance: {
      observedAt: 1_800_000_000_000,
      sourceId: id.source("source-1"),
      sourceUri: "fixture://source-1",
      sourceVersion: "1",
    },
    text: "The support ticket is open.",
    visibility: { grantId: "support-source-read", kind: "grant" as const },
  };
  const scope = {
    context: allowedContext,
    organizationId: fixtureOrganizationId,
  };
  const saved = await memoryStore.remember(scope, record, {
    deadlineAt: 1_900_000_000_000,
    operationId: id.operation("remember-granted"),
    requestDigest: id.digest("sha256:remember-granted"),
  });
  assert.equal(saved.status, "ok");
  const query = { ...scope, limit: 5, text: "support ticket" };
  const readOptions = { deadlineAt: 1_900_000_000_000 };
  const visible = await memoryStore.retrieve(query, readOptions);
  assert.equal(visible.status, "ok");
  if (visible.status !== "ok") {
    return;
  }
  assert.deepEqual(
    visible.value.map((hit) => hit.record.id),
    ["memory-granted"]
  );
  grants.get(allowedUser.id)?.delete("support-source-read");
  const revoked = await memoryStore.retrieve(query, readOptions);
  assert.deepEqual(revoked, { status: "ok", value: [] });
});

test("tool argument digests ignore object key order and reject non-JSON values", async () => {
  assert.equal(
    await digestToolArguments(
      Object.fromEntries([
        ["b", 2],
        ["a", [true, null, "text"]],
      ])
    ),
    await digestToolArguments({ a: [true, null, "text"], b: 2 })
  );
  assert.equal(
    canonicalToolArguments(
      Object.fromEntries([
        ["z", 1],
        [
          "a",
          Object.fromEntries([
            ["b", 2],
            ["a", 3],
          ]),
        ],
      ])
    ),
    '{"a":{"a":3,"b":2},"z":1}'
  );
  await assert.rejects(
    digestToolArguments({ ticket: undefined }),
    /Tool arguments must be JSON values/u
  );
  const sparse: unknown[] = [];
  sparse.length = 1;
  await assert.rejects(
    digestToolArguments(sparse),
    /Tool argument arrays must be dense JSON arrays/u
  );
});

test("artifact fixture checks current grants and copies stored bytes", async () => {
  const grants = new Map([[allowedUser.id, new Set(["artifact-read"])]]);
  const { artifactStore } = createFixtureAdapters({
    grantIdsByPrincipal: grants,
    mode: "fixture",
  });
  const scope = {
    context: allowedContext,
    organizationId: fixtureOrganizationId,
  };
  const metadata = {
    organizationId: fixtureOrganizationId,
    provenance: {
      observedAt: 1_800_000_000_000,
      sourceId: id.source("artifact-source"),
      sourceUri: "fixture://artifact-source",
      sourceVersion: "1",
    },
    visibility: { grantId: "artifact-read", kind: "grant" as const },
  };
  const stored = await artifactStore.put(
    scope,
    new Uint8Array([1, 2, 3]),
    metadata,
    {
      deadlineAt: 1_900_000_000_000,
      operationId: id.operation("put-artifact"),
      requestDigest: id.digest("sha256:artifact-put"),
    }
  );
  assert.equal(stored.status, "ok");
  if (stored.status !== "ok") {
    return;
  }
  const readOptions = { deadlineAt: 1_900_000_000_000 };
  const first = await artifactStore.read(scope, stored.value, readOptions);
  assert.equal(first.status, "ok");
  if (first.status !== "ok") {
    return;
  }
  assert.deepEqual([...first.value], [1, 2, 3]);
  first.value[0] = 99;
  const second = await artifactStore.read(scope, stored.value, readOptions);
  assert.equal(second.status, "ok");
  if (second.status !== "ok") {
    return;
  }
  assert.deepEqual([...second.value], [1, 2, 3]);
  grants.get(allowedUser.id)?.delete("artifact-read");
  assert.deepEqual(await artifactStore.read(scope, stored.value, readOptions), {
    code: "unauthorized",
    reason: "The principal cannot read this artifact.",
    status: "denied",
  });
});

// oxlint-disable unicorn/no-await-expression-member -- These assertions check the returned port status directly.
const fixtureEffect = (name: string) => ({
  deadlineAt: 1_900_000_000_000,
  operationId: id.operation(name),
  requestDigest: id.digest(`sha256:${name}`),
});

test("agent publish replay checks the definition and expected version", async () => {
  const { agentRepository } = createFixtureAdapters({ mode: "fixture" });
  const current = await agentRepository.get(
    fixtureOrganizationId,
    fixtureAgentId,
    1,
    { deadlineAt: 1_900_000_000_000 }
  );
  assert.equal(current.status, "ok");
  if (current.status !== "ok") {
    return;
  }
  const definition = { ...current.value, instructions: "Updated.", version: 2 };
  const effect = {
    deadlineAt: 1_900_000_000_000,
    operationId: id.operation("publish-bound"),
    requestDigest: id.digest("sha256:publish-bound"),
  };
  assert.equal(
    (await agentRepository.publish(definition, 1, effect)).status,
    "ok"
  );
  assert.equal(
    (
      await agentRepository.publish(
        { ...definition, instructions: "Changed." },
        1,
        effect
      )
    ).status,
    "conflict"
  );
  assert.equal(
    (await agentRepository.publish(definition, 0, effect)).status,
    "conflict"
  );
});

test("memory fixture binds record, source, and scope on replay", async () => {
  const { memoryStore } = createFixtureAdapters({ mode: "fixture" });
  const scope = {
    context: allowedContext,
    organizationId: fixtureOrganizationId,
  };
  const record = {
    id: "bound-memory",
    kind: "source-chunk" as const,
    provenance: {
      observedAt: 1_800_000_000_000,
      sourceId: id.source("bound-source"),
      sourceUri: "fixture://bound-source",
      sourceVersion: "1",
    },
    text: "Original text.",
    visibility: { kind: "organization" as const },
  };
  const effect = {
    deadlineAt: 1_900_000_000_000,
    operationId: id.operation("remember-bound"),
    requestDigest: id.digest("sha256:remember-bound"),
  };
  assert.equal(
    (await memoryStore.remember(scope, record, effect)).status,
    "ok"
  );
  assert.equal(
    (await memoryStore.remember(scope, { ...record, text: "Changed." }, effect))
      .status,
    "conflict"
  );
  assert.equal(
    (
      await memoryStore.remember(
        { ...scope, context: { actor: serviceActor } },
        record,
        effect
      )
    ).status,
    "conflict"
  );
  const forgetEffect = {
    ...effect,
    operationId: id.operation("forget-bound"),
  };
  assert.equal(
    (await memoryStore.forget(scope, record.provenance.sourceId, forgetEffect))
      .status,
    "ok"
  );
  assert.equal(
    (await memoryStore.forget(scope, id.source("other-source"), forgetEffect))
      .status,
    "conflict"
  );
});

test("artifact delete replay binds artifact and actor", async () => {
  const { artifactStore } = createFixtureAdapters({ mode: "fixture" });
  const scope = {
    context: allowedContext,
    organizationId: fixtureOrganizationId,
  };
  const metadata = {
    organizationId: fixtureOrganizationId,
    provenance: {
      observedAt: 1_800_000_000_000,
      sourceId: id.source("artifact-bound"),
      sourceUri: "fixture://artifact-bound",
      sourceVersion: "1",
    },
    visibility: { kind: "organization" as const },
  };
  const put = (name: string) =>
    artifactStore.put(scope, new Uint8Array([1]), metadata, {
      deadlineAt: 1_900_000_000_000,
      operationId: id.operation(name),
      requestDigest: id.digest(`sha256:${name}`),
    });
  const first = await put("artifact-bound-1");
  const second = await put("artifact-bound-2");
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  if (first.status !== "ok" || second.status !== "ok") {
    return;
  }
  const effect = {
    deadlineAt: 1_900_000_000_000,
    operationId: id.operation("artifact-delete-bound"),
    requestDigest: id.digest("sha256:artifact-delete-bound"),
  };
  assert.equal(
    (await artifactStore.delete(scope, first.value, effect)).status,
    "ok"
  );
  assert.equal(
    (await artifactStore.delete(scope, second.value, effect)).status,
    "conflict"
  );
  assert.equal(
    (
      await artifactStore.delete(
        { ...scope, context: { actor: serviceActor } },
        first.value,
        effect
      )
    ).status,
    "conflict"
  );
});

test("tool fixture replay checks the authorized call identity", async () => {
  const { toolExecutor } = createFixtureAdapters({ mode: "fixture" });
  const operationId = id.operation("tool-bound");
  const call = { ...unknownOutcomeInvocation, operationId };
  const capability = { ...unknownOutcomeCapability, operationId };
  const effect = {
    deadlineAt: 1_900_000_000_000,
    operationId,
    requestDigest: unknownOutcomeInvocation.argumentDigest,
  };
  assert.equal(
    (await toolExecutor.execute(call, capability, effect)).status,
    "ok"
  );
  const otherToolId = id.tool("tool-2");
  assert.equal(
    (
      await toolExecutor.execute(
        { ...call, tool: { ...call.tool, id: otherToolId } },
        { ...capability, toolId: otherToolId },
        effect
      )
    ).status,
    "conflict"
  );
});

test("agent definitions cannot change through input or read aliases", async () => {
  const { agentRepository } = createFixtureAdapters({ mode: "fixture" });
  const current = await agentRepository.get(
    fixtureOrganizationId,
    fixtureAgentId,
    1,
    { deadlineAt: 1_900_000_000_000 }
  );
  assert.equal(current.status, "ok");
  if (current.status !== "ok") {
    return;
  }
  const definition = { ...structuredClone(current.value), version: 2 };
  Reflect.set(current.value.enabledToolIds, 0, "tool-other");
  const originalVersion = await agentRepository.get(
    fixtureOrganizationId,
    fixtureAgentId,
    1,
    { deadlineAt: 1_900_000_000_000 }
  );
  assert.equal(originalVersion.status, "ok");
  if (originalVersion.status === "ok") {
    assert.deepEqual(originalVersion.value.enabledToolIds, ["tool-1"]);
  }
  const published = await agentRepository.publish(
    definition,
    1,
    fixtureEffect("publish-alias")
  );
  assert.equal(published.status, "ok");
  Reflect.set(definition.enabledToolIds, 0, "tool-other");
  if (published.status === "ok" && published.value.grants[0]) {
    Reflect.set(published.value.grants[0].resource, "id", "tool-other");
  }
  const reread = await agentRepository.get(
    fixtureOrganizationId,
    fixtureAgentId,
    2,
    { deadlineAt: 1_900_000_000_000 }
  );
  assert.equal(reread.status, "ok");
  if (reread.status === "ok") {
    assert.deepEqual(reread.value.enabledToolIds, ["tool-1"]);
    assert.equal(reread.value.grants[0]?.resource.id, "tool-1");
  }
});

test("memory and artifact visibility ignore caller mutation", async () => {
  const { artifactStore, memoryStore } = createFixtureAdapters({
    mode: "fixture",
  });
  const scope = {
    context: allowedContext,
    organizationId: fixtureOrganizationId,
  };
  const serviceScope = {
    context: { actor: serviceActor },
    organizationId: fixtureOrganizationId,
  };
  const visibility = { kind: "private" as const, ownerId: allowedUser.id };
  const provenance = {
    observedAt: 1_800_000_000_000,
    sourceId: id.source("alias-source"),
    sourceUri: "fixture://alias-source",
    sourceVersion: "1",
  };
  const record = {
    id: "memory-alias",
    kind: "source-chunk" as const,
    provenance,
    text: "Private entry.",
    visibility,
  };
  const remembered = await memoryStore.remember(
    scope,
    record,
    fixtureEffect("memory-alias")
  );
  assert.equal(remembered.status, "ok");
  if (remembered.status === "ok") {
    Reflect.set(remembered.value.visibility, "kind", "organization");
  }
  const ownerHits = await memoryStore.retrieve(
    { ...scope, limit: 10, text: "Private entry" },
    { deadlineAt: 1_900_000_000_000 }
  );
  assert.equal(ownerHits.status, "ok");
  if (ownerHits.status === "ok" && ownerHits.value[0]) {
    Reflect.set(ownerHits.value[0].record.visibility, "kind", "organization");
  }
  Reflect.set(visibility, "kind", "organization");
  const hits = await memoryStore.retrieve(
    { ...serviceScope, limit: 10, text: "Private entry" },
    { deadlineAt: 1_900_000_000_000 }
  );
  assert.deepEqual(hits, { status: "ok", value: [] });
  const metadata = {
    organizationId: fixtureOrganizationId,
    provenance,
    visibility: { kind: "private" as const, ownerId: allowedUser.id },
  };
  const stored = await artifactStore.put(
    scope,
    new Uint8Array([1]),
    metadata,
    fixtureEffect("artifact-alias")
  );
  assert.equal(stored.status, "ok");
  if (stored.status !== "ok") {
    return;
  }
  Reflect.set(metadata.visibility, "kind", "organization");
  Reflect.set(stored.value.visibility, "kind", "organization");
  const read = await artifactStore.read(serviceScope, stored.value, {
    deadlineAt: 1_900_000_000_000,
  });
  assert.equal(read.status, "denied");
});

// oxlint-enable unicorn/no-await-expression-member

test("tool output and replay ignore returned object mutation", async () => {
  const { toolExecutor } = createFixtureAdapters({
    mode: "fixture",
  });
  const argumentsValue = { ticket: "support-1" };
  const operationId = id.operation("tool-output-alias");
  const call = {
    ...unknownOutcomeInvocation,
    arguments: argumentsValue,
    operationId,
  };
  const capability = { ...unknownOutcomeCapability, operationId };
  const effect = {
    ...fixtureEffect("tool-output-alias"),
    requestDigest: unknownOutcomeInvocation.argumentDigest,
  };
  const executed = await toolExecutor.execute(call, capability, effect);
  assert.equal(executed.status, "ok");
  argumentsValue.ticket = "changed-input";
  if (
    executed.status === "ok" &&
    typeof executed.value.output === "object" &&
    executed.value.output !== null
  ) {
    const outputArguments = Reflect.get(executed.value.output, "arguments");
    if (typeof outputArguments === "object" && outputArguments !== null) {
      Reflect.set(outputArguments, "ticket", "changed-output");
    }
  }
  const replayed = await toolExecutor.execute(
    { ...call, arguments: { ticket: "support-1" } },
    capability,
    effect
  );
  assert.deepEqual(replayed, {
    status: "ok",
    value: {
      output: { arguments: { ticket: "support-1" }, toolId: call.tool.id },
    },
  });
});
