import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createAuth } from "@cerebro/auth";
import { createAuthorizationPolicy } from "@cerebro/authorization";
import { id } from "@cerebro/contracts/identity";
import { withDatabase } from "@cerebro/db";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import { scimProjectionGrant, scimUser } from "@cerebro/db/schema/auth";
import { organization } from "@cerebro/db/schema/core";
import { identityPrincipal } from "@cerebro/db/schema/identity";
import { and, eq } from "drizzle-orm";

const databaseUrl = process.env.IDENTITY_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "IDENTITY_TEST_DATABASE_URL is required for the PostgreSQL SCIM Group test."
  );
}

const authBaseURL = "http://127.0.0.1:18765/api/auth";
const userSchema = "urn:ietf:params:scim:schemas:core:2.0:User";
const groupSchema = "urn:ietf:params:scim:schemas:core:2.0:Group";
const patchSchema = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

test("SCIM Group HTTP membership changes current authorization", async () => {
  const suffix = randomUUID();
  const organizationId = `group-test-${suffix}`;
  const connectionId = `group-connection-${suffix}`;
  const groupExternalId = `entra-group-object-${suffix}`;
  const bearerToken = `scim-token-${suffix}`;
  const email = `group-${suffix}@example.test`;
  const headers = {
    Authorization: `Bearer ${bearerToken}`,
    "Content-Type": "application/scim+json",
  };

  await withDatabase({ DATABASE_URL: databaseUrl }, async (database) => {
    await database.insert(organization).values({
      id: organizationId,
      name: "SCIM Group PostgreSQL test",
    });
    const auth = createAuth(
      {
        BETTER_AUTH_SECRET: randomUUID() + randomUUID(),
        BETTER_AUTH_URL: authBaseURL,
        CORS_ORIGIN: "http://127.0.0.1:18765",
        ENTERPRISE_IDENTITY: {
          clientId: "client-a",
          clientSecret: "fixture-secret",
          domain: "example.test",
          groupRoles: { [groupExternalId]: ["support"] },
          issuer: "https://login.example.test/tenant-a/v2.0",
          organizationId,
          providerId: `entra-${suffix}`,
          scimBearerToken: bearerToken,
          scimConnectionId: connectionId,
          tenantId: "tenant-a",
        },
      },
      database
    );
    const userResponse = await auth.handler(
      new Request(`${authBaseURL}/scim/v2/Users`, {
        body: JSON.stringify({
          active: true,
          emails: [{ primary: true, value: email }],
          externalId: `entra-user-object-${suffix}`,
          name: { familyName: "User", givenName: "Group" },
          schemas: [userSchema],
          userName: email,
        }),
        headers,
        method: "POST",
      })
    );
    const userBody = await userResponse.text();
    assert.equal(userResponse.status, 201, userBody);
    const createdUser = JSON.parse(userBody) as { id: string };
    assert.ok(createdUser.id);

    const [directoryUser] = await database
      .select()
      .from(scimUser)
      .where(
        and(
          eq(scimUser.connectionId, connectionId),
          eq(scimUser.id, createdUser.id)
        )
      );
    assert.ok(directoryUser);
    const [principal] = await database
      .select()
      .from(identityPrincipal)
      .where(
        and(
          eq(identityPrincipal.organizationId, organizationId),
          eq(identityPrincipal.betterAuthUserId, directoryUser.userId)
        )
      );
    assert.ok(principal);

    const repository = createIdentityRepository(database);
    const permission = {
      action: "execute" as const,
      resourceId: "connector-1",
      resourceKind: "tool" as const,
    };
    await repository.setRolePermissions(organizationId, "support", [
      permission,
    ]);
    const policy = createAuthorizationPolicy(repository);
    const context = {
      actor: {
        id: id.principal(principal.id),
        kind: "human" as const,
        organizationId: id.organization(organizationId),
        state: "active" as const,
      },
    };
    const resource = {
      id: permission.resourceId,
      kind: permission.resourceKind,
      organizationId: id.organization(organizationId),
    };
    const evaluate = () =>
      policy.evaluate(context, "execute", resource, {
        deadlineAt: Date.now() + 30_000,
      });
    const projection = () =>
      database
        .select()
        .from(scimProjectionGrant)
        .where(
          and(
            eq(scimProjectionGrant.connectionId, connectionId),
            eq(scimProjectionGrant.scimUserId, createdUser.id)
          )
        );

    const groupResponse = await auth.handler(
      new Request(`${authBaseURL}/scim/v2/Groups`, {
        body: JSON.stringify({
          displayName: "Support Team",
          externalId: groupExternalId,
          members: [],
          schemas: [groupSchema],
        }),
        headers,
        method: "POST",
      })
    );
    const groupBody = await groupResponse.text();
    assert.equal(groupResponse.status, 201, groupBody);
    const createdGroup = JSON.parse(groupBody) as {
      externalId: string;
      id: string;
    };
    assert.ok(createdGroup.id);
    assert.equal(createdGroup.externalId, groupExternalId);
    const initialProjection = await projection();
    assert.equal(initialProjection.length, 0);
    const before = await evaluate();
    assert.equal(before.status, "ok");
    if (before.status === "ok") {
      assert.equal(before.value.decision, "deny");
    }

    const groupURL = `${authBaseURL}/scim/v2/Groups/${createdGroup.id}`;
    const addResponse = await auth.handler(
      new Request(groupURL, {
        body: JSON.stringify({
          Operations: [
            { op: "add", path: "members", value: [{ value: createdUser.id }] },
          ],
          schemas: [patchSchema],
        }),
        headers,
        method: "PATCH",
      })
    );
    assert.equal(addResponse.status, 200, await addResponse.text());
    const addedProjection = await projection();
    assert.equal(addedProjection.length, 1);
    assert.equal(addedProjection[0]?.role, "support");
    assert.equal(addedProjection[0]?.sourceId, createdGroup.id);
    assert.equal(addedProjection[0]?.sourceValue, groupExternalId);
    const withGroup = await evaluate();
    assert.equal(withGroup.status, "ok");
    if (withGroup.status === "ok") {
      assert.equal(withGroup.value.decision, "allow");
    }

    const removeResponse = await auth.handler(
      new Request(groupURL, {
        body: JSON.stringify({
          Operations: [
            {
              op: "remove",
              path: `members[value eq ${JSON.stringify(createdUser.id)}]`,
            },
          ],
          schemas: [patchSchema],
        }),
        headers,
        method: "PATCH",
      })
    );
    assert.equal(removeResponse.status, 200, await removeResponse.text());
    const removedProjection = await projection();
    assert.equal(removedProjection.length, 0);
    const withoutGroup = await evaluate();
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
  });
});
