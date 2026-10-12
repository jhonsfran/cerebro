import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import { createAuthorizationPolicy } from "../../packages/authorization/src/index.ts";
import {
  createAuthorizationService,
  authorizationLayer,
} from "../../packages/authorization/src/policy.ts";
import { AuthorityService } from "../../packages/contracts/src/authority-service.ts";
import { id } from "../../packages/contracts/src/index.ts";
import type { ExecutionContext } from "../../packages/contracts/src/index.ts";
import type { Action, Resource } from "../../packages/contracts/src/policy.ts";
import type {
  AuthorizationSnapshot,
  IdentityGrant,
  IdentityPrincipal,
} from "../../packages/db/src/repositories/identity.ts";
import { userEvent } from "../support/fixtures.ts";

const organizationId = id.organization("company-a");
const otherOrganizationId = id.organization("company-b");
const actorId = id.principal("actor");
const representedId = id.principal("represented");
const now = 1_800_000_000_000;
const options = { deadlineAt: now + 10_000 };
const actor: IdentityPrincipal = {
  betterAuthUserId: "user-a",
  createdAt: new Date(0),
  directoryManaged: false,
  id: actorId,
  kind: "human",
  organizationId,
  state: "active",
};
const represented: IdentityPrincipal = {
  ...actor,
  betterAuthUserId: "user-b",
  id: representedId,
};
const context: ExecutionContext = { actor };
const tool: Resource = { id: "connector-1", kind: "tool", organizationId };
const grant = (
  principalId: string,
  action: IdentityGrant["action"],
  resourceKind: IdentityGrant["resourceKind"],
  resourceId: string,
  source = "manual"
): IdentityGrant => ({
  action,
  organizationId,
  principalId,
  resourceId,
  resourceKind,
  source,
});
const baseSnapshot = (): AuthorizationSnapshot => ({
  actor,
  actorDirectoryActive: true,
  actorGrants: [grant(actorId, "execute", "tool", tool.id)],
  delegation: undefined,
  policyVersion: "identity:company-a:1",
  represented: undefined,
  representedDirectoryActive: false,
  representedGrants: [],
  scopes: [],
});
const expectDecision = async (
  snapshot: AuthorizationSnapshot,
  currentContext: ExecutionContext,
  action: Action,
  resource: Resource,
  expected: "allow" | "deny"
) => {
  const policy = createAuthorizationPolicy(
    { readSnapshot: () => Promise.resolve(snapshot) },
    () => now
  );
  const result = await policy.evaluate(
    currentContext,
    action,
    resource,
    options
  );
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.value.decision, expected);
  }
};

test("uses current grants and denies a cross-company resource", async () => {
  const snapshot = baseSnapshot();
  await expectDecision(snapshot, context, "execute", tool, "allow");
  await expectDecision(
    snapshot,
    context,
    "execute",
    { ...tool, organizationId: otherOrganizationId },
    "deny"
  );
  await expectDecision(
    { ...snapshot, actorGrants: [] },
    context,
    "execute",
    tool,
    "deny"
  );
});

test("delegated access intersects actor, represented principal, and scope", async () => {
  const delegation = {
    actorId,
    createdAt: new Date(0),
    expiresAt: new Date(now + 1000),
    id: id.delegation("delegation-a"),
    organizationId,
    representedId,
    revokedAt: null,
  };
  const delegatedContext: ExecutionContext = {
    actor,
    delegation: { ...delegation, expiresAt: delegation.expiresAt.getTime() },
    represented,
  };
  const snapshot: AuthorizationSnapshot = {
    ...baseSnapshot(),
    delegation,
    represented,
    representedDirectoryActive: true,
    representedGrants: [grant(representedId, "execute", "tool", tool.id)],
    scopes: [
      {
        action: "execute",
        delegationId: delegation.id,
        resourceId: tool.id,
        resourceKind: "tool",
      },
    ],
  };
  await expectDecision(snapshot, delegatedContext, "execute", tool, "allow");
  await expectDecision(
    { ...snapshot, actorGrants: [] },
    delegatedContext,
    "execute",
    tool,
    "deny"
  );
  await expectDecision(
    { ...snapshot, representedGrants: [] },
    delegatedContext,
    "execute",
    tool,
    "deny"
  );
  await expectDecision(
    { ...snapshot, scopes: [] },
    delegatedContext,
    "execute",
    tool,
    "deny"
  );
  await expectDecision(
    {
      ...snapshot,
      delegation: { ...delegation, revokedAt: new Date(now - 1) },
    },
    delegatedContext,
    "execute",
    tool,
    "deny"
  );
  await expectDecision(
    { ...snapshot, delegation: { ...delegation, expiresAt: new Date(now) } },
    delegatedContext,
    "execute",
    tool,
    "deny"
  );
});

test("a paused run loses access after principal deactivation", async () => {
  let current = baseSnapshot();
  let reads = 0;
  const policy = createAuthorizationPolicy(
    {
      readSnapshot: () => {
        reads += 1;
        return Promise.resolve(current);
      },
    },
    () => now
  );
  const before = await policy.evaluate(context, "execute", tool, options);
  current = {
    ...current,
    actor: { ...actor, state: "disabled" },
    policyVersion: "identity:company-a:2",
  };
  const after = await policy.evaluate(context, "execute", tool, options);
  assert.equal(reads, 2);
  assert.equal(before.status, "ok");
  assert.equal(after.status, "ok");
  if (before.status === "ok" && after.status === "ok") {
    assert.equal(before.value.decision, "allow");
    assert.equal(after.value.decision, "deny");
    assert.notEqual(before.value.policyVersion, after.value.policyVersion);
  }
});

test("SCIM group removal and directory deactivation revoke a grant", async () => {
  const scim = {
    ...baseSnapshot(),
    actor: { ...actor, directoryManaged: true },
    actorGrants: [
      grant(actorId, "execute", "tool", tool.id, "scim:group:external-id"),
    ],
    policyVersion: "identity:company-a:scim-1",
  };
  await expectDecision(scim, context, "execute", tool, "allow");
  await expectDecision(
    { ...scim, actorGrants: [], policyVersion: "identity:company-a:scim-2" },
    context,
    "execute",
    tool,
    "deny"
  );
  await expectDecision(
    { ...scim, actorDirectoryActive: false },
    context,
    "execute",
    tool,
    "deny"
  );
});

test("audit export grants stay in one company", async () => {
  const audit: Resource = { id: organizationId, kind: "audit", organizationId };
  const snapshot = {
    ...baseSnapshot(),
    actorGrants: [grant(actorId, "export", "audit", organizationId)],
  };
  await expectDecision(snapshot, context, "export", audit, "allow");
  await expectDecision(
    snapshot,
    context,
    "export",
    { ...audit, id: otherOrganizationId },
    "deny"
  );
  await expectDecision(
    snapshot,
    context,
    "export",
    { ...audit, organizationId: otherOrganizationId },
    "deny"
  );
  await expectDecision(
    { ...snapshot, actorGrants: [] },
    context,
    "export",
    audit,
    "deny"
  );
});

test("database failure returns unavailable and never allows", async () => {
  const policy = createAuthorizationPolicy(
    {
      readSnapshot: () => Promise.reject(new Error("database connection lost")),
    },
    () => now
  );
  const result = await policy.evaluate(context, "execute", tool, options);
  assert.deepEqual(result, {
    code: "provider-unavailable",
    reason: "The identity store is unavailable.",
    status: "unavailable",
  });
});

test("Effect authorization uses current repository identity and converts denial before dispatch", async () => {
  let snapshot = baseSnapshot();
  const request = {
    action: "execute" as const,
    address: { ...userEvent, organizationId },
    context,
    pinnedAgent: {
      agentId: userEvent.agentId,
      enabledToolIds: [],
      grants: [],
      instructions: "Fixture",
      model: "fixture/model",
      organizationId,
      version: 1,
    },
    resource: tool,
  };
  const repository = { readSnapshot: () => Promise.resolve(snapshot) };
  const service = createAuthorizationService(repository, () => now);
  const permit = await Effect.runPromise(
    Effect.gen(function* requireAuthority() {
      const authority = yield* AuthorityService;
      return yield* authority.require(request, options);
    }).pipe(Effect.provide(authorizationLayer(repository, () => now)))
  );
  assert.equal(permit.policyVersion, snapshot.policyVersion);
  snapshot = { ...snapshot, actorGrants: [] };
  const denied = await Effect.runPromise(
    Effect.result(service.require(request, options))
  );
  assert.equal(denied._tag, "Failure");
  if (denied._tag === "Failure") {
    assert.equal(denied.failure._tag, "Denied");
  }
  snapshot = baseSnapshot();
  const forged = await Effect.runPromise(
    service.evaluate(
      { ...request, context: { actor: { ...actor, kind: "service" } } },
      options
    )
  );
  assert.equal(forged.decision, "deny");
});

test(
  "an authorization read stops waiting at its deadline",
  { timeout: 1000 },
  async () => {
    const policy = createAuthorizationPolicy(
      {
        readSnapshot: () =>
          Promise.withResolvers<AuthorizationSnapshot>().promise,
      },
      Date.now
    );
    const result = await policy.evaluate(context, "execute", tool, {
      deadlineAt: Date.now() + 20,
    });
    assert.equal(result.status, "unavailable");
    if (result.status === "unavailable") {
      assert.equal(result.code, "deadline-exceeded");
    }
  }
);

test(
  "an aborted authorization read stops waiting",
  { timeout: 1000 },
  async () => {
    const controller = new AbortController();
    const policy = createAuthorizationPolicy(
      {
        readSnapshot: () =>
          Promise.withResolvers<AuthorizationSnapshot>().promise,
      },
      Date.now
    );
    setTimeout(() => controller.abort(), 20);
    const result = await policy.evaluate(context, "execute", tool, {
      deadlineAt: Date.now() + 500,
      signal: controller.signal,
    });
    assert.equal(result.status, "unavailable");
    if (result.status === "unavailable") {
      assert.equal(result.code, "cancelled");
    }
  }
);
