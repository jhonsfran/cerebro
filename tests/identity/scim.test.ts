import assert from "node:assert/strict";
import { test } from "node:test";

import { scim } from "../../packages/auth/node_modules/@better-auth/scim/dist/index.mjs";
import { enterpriseSCIM } from "../../packages/auth/src/enterprise.ts";
import type { EnterpriseIdentityConfig } from "../../packages/auth/src/enterprise.ts";

const config: EnterpriseIdentityConfig = {
  clientId: "client-a",
  clientSecret: "secret-a",
  domain: "example.test",
  groupRoles: {
    "group-admin-object-id": ["admin"],
    "group-reader-object-id": ["reader"],
  },
  issuer: "https://login.example.test/tenant-a/v2.0",
  organizationId: "company-a",
  providerId: "entra",
  scimBearerToken: "token-a",
  scimConnectionId: "scim-a",
  tenantId: "tenant-a",
};

test("SCIM accepts only configured stable group external IDs", async () => {
  const options = enterpriseSCIM(config);
  const roles = options.projection?.roles;
  assert.ok(roles);
  const input = {
    connectionId: "scim-a",
    provisioningDomainId: "company-a",
    scimUserId: "scim-user-a",
    source: {
      displayName: "Changed display name",
      externalId: "group-admin-object-id",
      id: "scim-group-a",
      type: "group" as const,
    },
    userId: "user-a",
  };
  const mapRole = roles.map;
  assert.deepEqual(await mapRole(input, {} as never), ["admin"]);
  assert.deepEqual(
    await mapRole(
      {
        ...input,
        source: {
          displayName: "group-admin-object-id",
          id: "scim-group-b",
          type: "group",
        },
      },
      {} as never
    ),
    []
  );
  assert.equal(
    await roles.exists(
      {
        connectionId: "scim-a",
        provisioningDomainId: "company-a",
        role: "admin",
      },
      {} as never
    ),
    true
  );
  assert.equal(
    await roles.exists(
      {
        connectionId: "scim-a",
        provisioningDomainId: "company-a",
        role: "owner",
      },
      {} as never
    ),
    false
  );

  const plugin = scim(options);
  assert.ok(plugin.schema.scimProjectionGrant);
  assert.ok(plugin.schema.scimGroupMember);
});

test("SCIM deactivation disables the principal and consumes link challenges in its transaction", async () => {
  const reconcile = enterpriseSCIM(config).identity?.reconcileUser;
  assert.ok(reconcile);
  let principal: Record<string, unknown> | null = null;
  const updatedDelegations: { where: unknown; update: unknown }[] = [];
  const updatedChallenges: { where: unknown; update: unknown }[] = [];
  const deletedSessions: { where: unknown }[] = [];
  const database = {
    create: (query: { model: string; data: Record<string, unknown> }) => {
      assert.equal(query.model, "identityPrincipal");
      assert.equal("id" in query.data, false);
      principal = { ...query.data, id: "principal-a" };
      return Promise.resolve(principal);
    },
    deleteMany: (query: { model: string; where: unknown }) => {
      assert.equal(query.model, "session");
      deletedSessions.push(query);
      return Promise.resolve(1);
    },
    findOne: (query: { model: string }) =>
      Promise.resolve(query.model === "identityPrincipal" ? principal : null),
    update: (query: { model: string; update: Record<string, unknown> }) => {
      assert.equal(query.model, "identityPrincipal");
      principal = { ...principal, ...query.update };
      return Promise.resolve(principal);
    },
    updateMany: (query: { model: string; where: unknown; update: unknown }) => {
      if (query.model === "identityDelegation") {
        updatedDelegations.push(query);
      } else {
        assert.equal(query.model, "identitySlackLinkChallenge");
        updatedChallenges.push(query);
      }
      return Promise.resolve(1);
    },
  };
  const input = {
    active: true,
    sources: [
      {
        active: true,
        connectionId: "scim-a",
        id: "scim-user-a",
        provisioningDomainId: "company-a",
      },
    ],
    userId: "user-a",
  };
  await reconcile(input, { database } as never);
  assert.equal(principal?.state, "active");
  assert.equal(principal?.directoryManaged, true);

  await reconcile(
    {
      ...input,
      active: false,
      sources: [{ ...input.sources[0], active: false }],
    },
    { database } as never
  );
  assert.equal(principal?.state, "disabled");
  assert.equal(updatedDelegations.length, 2);
  assert.ok(
    updatedDelegations.every(({ where }) =>
      (where as { field: string; value: unknown }[]).some(
        (condition) =>
          (condition.field === "actorId" &&
            condition.value === "principal-a") ||
          (condition.field === "representedId" &&
            condition.value === "principal-a")
      )
    )
  );
  assert.ok(
    updatedDelegations.every(
      ({ update }) =>
        typeof (update as { revokedAt?: unknown }).revokedAt === "object"
    )
  );
  assert.equal(updatedChallenges.length, 1);
  assert.deepEqual(updatedChallenges[0]?.where, [
    { field: "organizationId", value: "company-a" },
    { field: "principalId", value: "principal-a" },
    { field: "consumedAt", value: null },
  ]);
  assert.ok(
    (updatedChallenges[0]?.update as { consumedAt?: unknown })
      ?.consumedAt instanceof Date
  );
  assert.equal(deletedSessions.length, 1);
  assert.deepEqual(deletedSessions[0]?.where, [
    { field: "userId", value: "user-a" },
  ]);
});
