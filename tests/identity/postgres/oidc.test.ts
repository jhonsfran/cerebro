import assert from "node:assert/strict";
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import { test } from "node:test";

import { and, eq } from "drizzle-orm";

import { createAuth } from "../../../packages/auth/src/index.ts";
import { withDatabase } from "../../../packages/db/src/index.ts";
import {
  account,
  scimUser,
  session,
  user,
} from "../../../packages/db/src/schema/auth.ts";
import { organization } from "../../../packages/db/src/schema/core.ts";
import { identityPrincipal } from "../../../packages/db/src/schema/identity.ts";

const databaseUrl = process.env.IDENTITY_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "IDENTITY_TEST_DATABASE_URL is required for the PostgreSQL OIDC test."
  );
}

const authBaseURL = "http://127.0.0.1:18765/api/auth";
const callbackURL = "http://127.0.0.1:18765/after-login";
const coreUserSchema = "urn:ietf:params:scim:schemas:core:2.0:User";

const encode = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const signIdToken = (
  payload: Record<string, unknown>,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]
): string => {
  const input = `${encode({ alg: "RS256", kid: "fixture-key", typ: "JWT" })}.${encode(payload)}`;
  const signature = createSign("RSA-SHA256").update(input).sign(privateKey);
  return `${input}.${signature.toString("base64url")}`;
};

test("PostgreSQL OIDC HTTP callback links only the SCIM provisioned user", async () => {
  const suffix = randomUUID();
  const tenantId = `tenant-${suffix}`;
  const organizationId = `oidc-test-${suffix}`;
  const connectionId = `oidc-connection-${suffix}`;
  const providerId = `entra-${suffix}`;
  const email = `oidc-${suffix}@example.test`;
  const objectId = `object-${suffix}`;
  const subject = `subject-${suffix}`;
  const clientId = `client-${suffix}`;
  const clientSecret = `secret-${suffix}`;
  const bearerToken = `scim-token-${suffix}`;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const authorizationCodes = new Map<string, string>();
  let discoveryRequests = 0;
  let jwksRequests = 0;
  let tokenRequests = 0;
  let issuer = "";

  const idp = Bun.serve({
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/.well-known/openid-configuration")) {
        discoveryRequests += 1;
        return Response.json({
          authorization_endpoint: `${issuer}/authorize`,
          id_token_signing_alg_values_supported: ["RS256"],
          issuer,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          token_endpoint: `${issuer}/token`,
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        });
      }
      if (url.pathname.endsWith("/jwks")) {
        jwksRequests += 1;
        return Response.json({
          keys: [
            {
              ...publicKey.export({ format: "jwk" }),
              alg: "RS256",
              kid: "fixture-key",
              use: "sig",
            },
          ],
        });
      }
      if (url.pathname.endsWith("/authorize")) {
        if (
          url.searchParams.get("client_id") !== clientId ||
          url.searchParams.get("response_type") !== "code" ||
          url.searchParams.get("code_challenge_method") !== "S256"
        ) {
          return new Response("Invalid authorization request", { status: 400 });
        }
        const state = url.searchParams.get("state");
        const challenge = url.searchParams.get("code_challenge");
        const redirectURI = url.searchParams.get("redirect_uri");
        if (!state || !challenge || !redirectURI) {
          return new Response("Missing authorization parameter", {
            status: 400,
          });
        }
        const code = randomUUID();
        authorizationCodes.set(code, challenge);
        const callback = new URL(redirectURI);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", state);
        return Response.redirect(callback, 302);
      }
      if (url.pathname.endsWith("/token")) {
        tokenRequests += 1;
        const expectedCredentials = Buffer.from(
          `${clientId}:${clientSecret}`
        ).toString("base64");
        if (
          request.headers.get("authorization") !==
          `Basic ${expectedCredentials}`
        ) {
          return Response.json({ error: "invalid_client" }, { status: 401 });
        }
        const body = new URLSearchParams(await request.text());
        const challenge = authorizationCodes.get(body.get("code") ?? "");
        const verifier = body.get("code_verifier");
        const actualChallenge = verifier
          ? createHash("sha256").update(verifier).digest("base64url")
          : "";
        if (
          body.get("grant_type") !== "authorization_code" ||
          body.get("redirect_uri") !==
            `${authBaseURL}/sso/callback/${providerId}` ||
          !challenge ||
          actualChallenge !== challenge
        ) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        authorizationCodes.delete(body.get("code") ?? "");
        const now = Math.floor(Date.now() / 1000);
        return Response.json({
          access_token: `access-${suffix}`,
          expires_in: 300,
          id_token: signIdToken(
            {
              aud: clientId,
              email,
              exp: now + 300,
              iat: now,
              iss: issuer,
              name: "OIDC Fixture User",
              oid: objectId,
              sub: subject,
              tid: tenantId,
            },
            privateKey
          ),
          token_type: "Bearer",
        });
      }
      return new Response("Not found", { status: 404 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  issuer = `http://127.0.0.1:${idp.port}/${tenantId}/v2.0`;

  try {
    await withDatabase({ DATABASE_URL: databaseUrl }, async (database) => {
      await database.insert(organization).values({
        id: organizationId,
        name: "OIDC PostgreSQL test",
      });
      const auth = createAuth(
        {
          BETTER_AUTH_SECRET: randomUUID() + randomUUID(),
          BETTER_AUTH_URL: authBaseURL,
          CORS_ORIGIN: "http://127.0.0.1:18765",
          ENTERPRISE_IDENTITY: {
            clientId,
            clientSecret,
            domain: "example.test",
            groupRoles: {},
            issuer,
            organizationId,
            providerId,
            scimBearerToken: bearerToken,
            scimConnectionId: connectionId,
            tenantId,
          },
        },
        database
      );
      const provision = await auth.handler(
        new Request(`${authBaseURL}/scim/v2/Users`, {
          body: JSON.stringify({
            active: true,
            emails: [{ primary: true, value: email }],
            externalId: objectId,
            name: { familyName: "User", givenName: "Fixture" },
            schemas: [coreUserSchema],
            userName: email,
          }),
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            "Content-Type": "application/scim+json",
          },
          method: "POST",
        })
      );
      assert.equal(provision.status, 201, await provision.text());
      const [source] = await database
        .select()
        .from(scimUser)
        .where(
          and(
            eq(scimUser.connectionId, connectionId),
            eq(scimUser.externalId, objectId)
          )
        );
      assert.ok(source);

      const signIn = await auth.handler(
        new Request(`${authBaseURL}/sign-in/sso`, {
          body: JSON.stringify({ callbackURL, providerId }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
      );
      const signInBody = await signIn.text();
      assert.equal(signIn.status, 200, signInBody);
      const { url: authorizationURL } = JSON.parse(signInBody) as {
        url: string;
      };
      assert.equal(new URL(authorizationURL).origin, new URL(issuer).origin);
      const authorization = await fetch(authorizationURL, {
        redirect: "manual",
      });
      assert.equal(authorization.status, 302);
      const callback = authorization.headers.get("location");
      assert.ok(callback);
      const cookies = signIn.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const signedIn = await auth.handler(
        new Request(callback, { headers: { Cookie: cookies } })
      );
      assert.equal(signedIn.status, 302, await signedIn.text());
      assert.equal(signedIn.headers.get("location"), callbackURL);
      assert.ok(signedIn.headers.getSetCookie().length > 0);
      assert.ok(discoveryRequests >= 1);
      assert.ok(jwksRequests >= 1);
      assert.equal(tokenRequests, 1);

      const accounts = await database
        .select()
        .from(account)
        .where(
          and(
            eq(account.providerId, providerId),
            eq(account.accountId, subject)
          )
        );
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0]?.userId, source.userId);
      const principal = await database
        .select()
        .from(identityPrincipal)
        .where(eq(identityPrincipal.betterAuthUserId, source.userId));
      assert.equal(principal.length, 1);
      assert.equal(principal[0]?.state, "active");
      assert.equal(principal[0]?.organizationId, organizationId);
      const sessions = await database
        .select()
        .from(session)
        .where(eq(session.userId, source.userId));
      assert.equal(sessions.length, 1);
      const users = await database
        .select()
        .from(user)
        .where(eq(user.email, email));
      assert.equal(users.length, 1);
    });
  } finally {
    idp.stop();
  }
});
