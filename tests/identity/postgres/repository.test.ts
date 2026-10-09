import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import { createAuthorizationPolicy } from "@cerebro/authorization";
import { id } from "@cerebro/contracts/identity";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import {
  scimConnectionBinding,
  scimProjectionGrant,
  scimUser,
  user,
} from "@cerebro/db/schema/auth";
import { organization } from "@cerebro/db/schema/core";
import {
  identityPrincipal,
  identityRolePermission,
} from "@cerebro/db/schema/identity";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const databaseUrl = process.env.IDENTITY_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "IDENTITY_TEST_DATABASE_URL is required for the PostgreSQL identity repository test."
  );
}

const client = postgres(databaseUrl, { max: 5, prepare: false });
const database = drizzle(client);
const repository = createIdentityRepository(database);
const suffix = randomUUID();
const organizationId = `identity-test-${suffix}`;
const authUserId = `identity-user-${suffix}`;
const principalContext = (principalId: string) => ({
  actor: {
    id: id.principal(principalId),
    kind: "human" as const,
    organizationId: id.organization(organizationId),
    state: "active" as const,
  },
});
const digest = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

test("PostgreSQL identity grants and Slack challenges use current state", async () => {
  try {
    await database
      .insert(organization)
      .values({ id: organizationId, name: "Identity repository test" });
    await database.insert(user).values({
      email: `${suffix}@example.test`,
      emailVerified: true,
      id: authUserId,
      name: "Identity User",
    });
    const principal = await repository.provisionHumanPrincipal(
      organizationId,
      authUserId
    );
    const resource = {
      id: "connector-1",
      kind: "tool" as const,
      organizationId: id.organization(organizationId),
    };
    const policy = createAuthorizationPolicy(repository);
    const context = principalContext(principal.id);
    const options = { deadlineAt: Date.now() + 30_000 };
    const permission = {
      action: "execute" as const,
      resourceId: resource.id,
      resourceKind: "tool" as const,
    };

    await repository.setManualGrant(
      organizationId,
      principal.id,
      permission,
      true
    );
    const allowed = await policy.evaluate(
      context,
      "execute",
      resource,
      options
    );
    assert.equal(allowed.status, "ok");
    if (allowed.status === "ok") {
      assert.equal(allowed.value.decision, "allow");
    }

    await repository.setManualGrant(
      organizationId,
      principal.id,
      permission,
      false
    );
    const denied = await policy.evaluate(context, "execute", resource, options);
    assert.equal(denied.status, "ok");
    if (denied.status === "ok") {
      assert.equal(denied.value.decision, "deny");
    }
    if (allowed.status === "ok" && denied.status === "ok") {
      assert.notEqual(allowed.value.policyVersion, denied.value.policyVersion);
    }

    const directoryAuthUserId = `directory-user-${suffix}`;
    await database.insert(user).values({
      email: `directory-${suffix}@example.test`,
      emailVerified: true,
      id: directoryAuthUserId,
      name: "Directory User",
    });
    const [directoryPrincipal] = await database
      .insert(identityPrincipal)
      .values({
        betterAuthUserId: directoryAuthUserId,
        directoryManaged: true,
        id: `directory-principal-${suffix}`,
        kind: "human",
        organizationId,
      })
      .returning();
    if (!directoryPrincipal) {
      throw new Error("Could not create the directory principal fixture.");
    }
    await assert.rejects(
      () =>
        repository.setPrincipalActive(
          organizationId,
          directoryPrincipal.id,
          false
        ),
      /through SCIM/u
    );
    await repository.setRolePermissions(organizationId, "support", [
      permission,
    ]);
    const directoryScimUserId = `scim-user-${suffix}`;
    const timestamp = new Date();
    await database.insert(scimConnectionBinding).values({
      connectionId: "scim-connection",
      connectionKey: `connection-${suffix}`,
      createdAt: timestamp,
      id: `binding-${suffix}`,
      provisioningDomainId: organizationId,
    });
    await database.insert(scimUser).values({
      active: true,
      connectionId: "scim-connection",
      connectionUserKey: `connection-user-${suffix}`,
      createdAt: timestamp,
      displayName: "Directory User",
      emailValueIndex: `directory-${suffix}@example.test`,
      formattedName: "Directory User",
      id: directoryScimUserId,
      orderKey: `order-${suffix}`,
      primaryEmail: `directory-${suffix}@example.test`,
      provisioningDomainId: organizationId,
      serializedEmails: "[]",
      updatedAt: timestamp,
      userId: directoryAuthUserId,
      userName: `directory-${suffix}`,
      userNameKey: `directory-${suffix}`,
      workEmailValueIndex: `directory-${suffix}@example.test`,
    });
    const projectionId = `projection-${suffix}`;
    await database.insert(scimProjectionGrant).values({
      connectionId: "scim-connection",
      createdAt: timestamp,
      grantKey: `grant-${suffix}`,
      id: projectionId,
      provisioningDomainId: organizationId,
      role: "support",
      scimUserId: directoryScimUserId,
      sourceId: `group-${suffix}`,
      sourceKind: "group",
      sourceValue: `group-${suffix}`,
      updatedAt: timestamp,
      userId: directoryAuthUserId,
    });
    const directoryContext = principalContext(directoryPrincipal.id);
    const withGroup = await policy.evaluate(
      directoryContext,
      "execute",
      resource,
      options
    );
    assert.equal(withGroup.status, "ok");
    if (withGroup.status === "ok") {
      assert.equal(withGroup.value.decision, "allow");
    }
    await database
      .delete(scimProjectionGrant)
      .where(eq(scimProjectionGrant.id, projectionId));
    const withoutGroup = await policy.evaluate(
      directoryContext,
      "execute",
      resource,
      options
    );
    assert.equal(withoutGroup.status, "ok");
    if (withoutGroup.status === "ok") {
      assert.equal(withoutGroup.value.decision, "deny");
    }
    if (withGroup.status === "ok" && withoutGroup.status === "ok") {
      assert.notEqual(
        withGroup.value.policyVersion,
        withoutGroup.value.policyVersion
      );
    }
    await repository.setManualGrant(
      organizationId,
      directoryPrincipal.id,
      permission,
      true
    );
    const directoryChallengeDigest = digest(`directory-link-${suffix}`);
    await repository.createSlackLinkChallenge(
      organizationId,
      directoryPrincipal.id,
      directoryChallengeDigest,
      new Date(Date.now() + 60_000)
    );
    await database
      .update(scimUser)
      .set({ active: false })
      .where(eq(scimUser.id, directoryScimUserId));
    const directoryDisabled = await policy.evaluate(
      directoryContext,
      "execute",
      resource,
      options
    );
    assert.equal(directoryDisabled.status, "ok");
    if (directoryDisabled.status === "ok") {
      assert.equal(directoryDisabled.value.decision, "deny");
    }
    await assert.rejects(
      () =>
        repository.consumeSlackLinkChallenge(
          organizationId,
          directoryChallengeDigest,
          "workspace-1",
          `directory-slack-${suffix}`,
          new Date()
        ),
      /no longer active or linked/u
    );
    await assert.rejects(
      () =>
        repository.createSlackLinkChallenge(
          organizationId,
          directoryPrincipal.id,
          digest(`new-directory-link-${suffix}`),
          new Date(Date.now() + 60_000)
        ),
      /active linked Better Auth user/u
    );
    await database
      .update(scimUser)
      .set({ active: true })
      .where(eq(scimUser.id, directoryScimUserId));
    await database
      .update(scimConnectionBinding)
      .set({ decommissionStatus: "reconciling" })
      .where(eq(scimConnectionBinding.id, `binding-${suffix}`));
    const decommissioned = await policy.evaluate(
      directoryContext,
      "execute",
      resource,
      options
    );
    assert.equal(decommissioned.status, "ok");
    if (decommissioned.status === "ok") {
      assert.equal(decommissioned.value.decision, "deny");
    }
    await assert.rejects(
      () =>
        repository.createSlackLinkChallenge(
          organizationId,
          directoryPrincipal.id,
          digest(`decommissioned-link-${suffix}`),
          new Date(Date.now() + 60_000)
        ),
      /active linked Better Auth user/u
    );

    const baseTime = Date.now();
    const challengeDigest = digest(`link-${suffix}`);
    await repository.createSlackLinkChallenge(
      organizationId,
      principal.id,
      challengeDigest,
      new Date(baseTime + 60_000)
    );
    const consumed = await Promise.all([
      repository.consumeSlackLinkChallenge(
        organizationId,
        challengeDigest,
        "workspace-1",
        `slack-${suffix}`,
        new Date(baseTime)
      ),
      repository.consumeSlackLinkChallenge(
        organizationId,
        challengeDigest,
        "workspace-1",
        `slack-${suffix}`,
        new Date(baseTime)
      ),
    ]);
    assert.equal(consumed.filter(Boolean).length, 1);
    const resolvedLink = await repository.resolveSlackLink(
      "workspace-1",
      `slack-${suffix}`
    );
    assert.equal(resolvedLink?.principalId, principal.id);
    assert.equal(
      await repository.consumeSlackLinkChallenge(
        organizationId,
        challengeDigest,
        "workspace-1",
        `slack-${suffix}`,
        new Date(baseTime)
      ),
      undefined
    );

    const expiredDigest = digest(`expired-${suffix}`);
    await repository.createSlackLinkChallenge(
      organizationId,
      principal.id,
      expiredDigest,
      new Date(baseTime + 60_000)
    );
    assert.equal(
      await repository.consumeSlackLinkChallenge(
        organizationId,
        expiredDigest,
        "workspace-1",
        `expired-${suffix}`,
        new Date(baseTime + 60_001)
      ),
      undefined
    );
    await repository.setPrincipalActive(organizationId, principal.id, false);
    assert.equal(
      await repository.resolveSlackLink("workspace-1", `slack-${suffix}`),
      undefined
    );
  } finally {
    await client.end({ timeout: 2 });
  }
});

test("concurrent role replacements leave one complete permission set", async () => {
  const roleOrganizationId = `identity-role-${randomUUID()}`;
  const roleClient = postgres(databaseUrl, { max: 5, prepare: false });
  const roleDatabase = drizzle(roleClient);
  const roleRepository = createIdentityRepository(roleDatabase);
  try {
    await roleDatabase.insert(organization).values({
      id: roleOrganizationId,
      name: "Role replacement test",
    });
    const first = {
      action: "execute" as const,
      resourceId: "first-tool",
      resourceKind: "tool" as const,
    };
    const second = { ...first, resourceId: "second-tool" };
    await Promise.all([
      roleRepository.setRolePermissions(roleOrganizationId, "support", [first]),
      roleRepository.setRolePermissions(roleOrganizationId, "support", [
        second,
      ]),
    ]);
    const permissions = await roleDatabase
      .select()
      .from(identityRolePermission)
      .where(
        and(
          eq(identityRolePermission.organizationId, roleOrganizationId),
          eq(identityRolePermission.roleId, "support")
        )
      );
    assert.equal(permissions.length, 1);
    assert.ok(
      permissions[0]?.resourceId === first.resourceId ||
        permissions[0]?.resourceId === second.resourceId
    );
  } finally {
    await roleClient.end({ timeout: 2 });
  }
});
