import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createAuth } from "@cerebro/auth";
import { withDatabase } from "@cerebro/db";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import { session } from "@cerebro/db/schema/auth";
import { organization } from "@cerebro/db/schema/core";
import {
  identityDelegation,
  identityPrincipal,
  identitySlackLinkChallenge,
} from "@cerebro/db/schema/identity";
import { and, eq } from "drizzle-orm";

const databaseUrl = process.env.IDENTITY_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "IDENTITY_TEST_DATABASE_URL is required for the PostgreSQL SCIM test."
  );
}

const suffix = randomUUID();
const organizationId = `scim-test-${suffix}`;
const connectionId = `scim-connection-${suffix}`;
const email = `scim-${suffix}@example.test`;
const externalId = `object-${suffix}`;
const bearerToken = `scim-token-${suffix}`;
const authBaseURL = "http://127.0.0.1:18765/api/auth";
const scimURL = `${authBaseURL}/scim/v2/Users`;
const coreUserSchema = "urn:ietf:params:scim:schemas:core:2.0:User";
const patchSchema = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

test("PostgreSQL SCIM HTTP provisioning and deactivation revoke access", async () => {
  await withDatabase({ DATABASE_URL: databaseUrl }, async (database) => {
    await database.insert(organization).values({
      id: organizationId,
      name: "SCIM PostgreSQL test",
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
          groupRoles: {},
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
    const headers = {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/scim+json",
    };
    const createResponse = await auth.handler(
      new Request(scimURL, {
        body: JSON.stringify({
          active: true,
          emails: [{ primary: true, value: email }],
          externalId,
          name: { familyName: "Bar", givenName: "Foo" },
          schemas: [coreUserSchema],
          userName: email,
        }),
        headers,
        method: "POST",
      })
    );
    const createBody = await createResponse.text();
    assert.equal(createResponse.status, 201, createBody);
    const created = JSON.parse(createBody) as { id: string };
    assert.ok(created.id);

    const principals = await database
      .select()
      .from(identityPrincipal)
      .where(eq(identityPrincipal.organizationId, organizationId));
    assert.equal(principals.length, 1);
    const [principal] = principals;
    assert.ok(principal);
    assert.equal(principal?.state, "active");
    assert.equal(principal?.directoryManaged, true);
    assert.ok(principal?.betterAuthUserId);

    const delegationId = `delegation-${suffix}`;
    const sessionId = `session-${suffix}`;
    const expiresAt = new Date(Date.now() + 60_000);
    await database.insert(identityDelegation).values({
      actorId: principal.id,
      expiresAt,
      id: delegationId,
      organizationId,
      representedId: principal.id,
    });
    await database.insert(session).values({
      expiresAt,
      id: sessionId,
      token: `session-token-${suffix}`,
      userId: principal.betterAuthUserId,
    });
    const challengeId = `challenge-${suffix}`;
    const challengeDigest = `digest-${suffix}`;
    await database.insert(identitySlackLinkChallenge).values({
      betterAuthUserId: principal.betterAuthUserId,
      digest: challengeDigest,
      expiresAt,
      id: challengeId,
      organizationId,
      principalId: principal.id,
    });

    const patchResponse = await auth.handler(
      new Request(`${scimURL}/${created.id}`, {
        body: JSON.stringify({
          Operations: [{ op: "replace", path: "active", value: false }],
          schemas: [patchSchema],
        }),
        headers,
        method: "PATCH",
      })
    );
    assert.equal(patchResponse.status, 200, await patchResponse.text());

    const [disabled] = await database
      .select()
      .from(identityPrincipal)
      .where(eq(identityPrincipal.id, principal.id));
    assert.equal(disabled?.state, "disabled");
    assert.equal(disabled?.directoryManaged, true);

    const [delegation] = await database
      .select()
      .from(identityDelegation)
      .where(eq(identityDelegation.id, delegationId));
    assert.ok(delegation?.revokedAt);
    const sessions = await database
      .select()
      .from(session)
      .where(
        and(
          eq(session.id, sessionId),
          eq(session.userId, principal.betterAuthUserId)
        )
      );
    assert.equal(sessions.length, 0);
    const [consumedChallenge] = await database
      .select()
      .from(identitySlackLinkChallenge)
      .where(eq(identitySlackLinkChallenge.id, challengeId));
    assert.ok(consumedChallenge?.consumedAt);

    const reactivateResponse = await auth.handler(
      new Request(`${scimURL}/${created.id}`, {
        body: JSON.stringify({
          Operations: [{ op: "replace", path: "active", value: true }],
          schemas: [patchSchema],
        }),
        headers,
        method: "PATCH",
      })
    );
    assert.equal(
      reactivateResponse.status,
      200,
      await reactivateResponse.text()
    );
    const [reactivated] = await database
      .select()
      .from(identityPrincipal)
      .where(eq(identityPrincipal.id, principal.id));
    assert.equal(reactivated?.state, "active");
    assert.equal(
      await createIdentityRepository(database).consumeSlackLinkChallenge(
        organizationId,
        challengeDigest,
        `workspace-${suffix}`,
        `slack-${suffix}`,
        new Date()
      ),
      undefined
    );
  });
});
