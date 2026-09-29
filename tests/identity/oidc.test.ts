import assert from "node:assert/strict";
import { test } from "node:test";

import {
  enterpriseSSO,
  parseEnterpriseIdentityConfig,
  parseEnterpriseIdentityJSON,
} from "../../packages/auth/src/enterprise.ts";
import type { EnterpriseIdentityConfig } from "../../packages/auth/src/enterprise.ts";

const config: EnterpriseIdentityConfig = {
  clientId: "client-a",
  clientSecret: "secret-a",
  domain: "example.test",
  groupRoles: {},
  issuer: "https://login.example.test/tenant-a/v2.0",
  organizationId: "company-a",
  providerId: "entra",
  scimBearerToken: "token-a",
  scimConnectionId: "scim-a",
  tenantId: "tenant-a",
};

const oidcInput = (claims: Record<string, unknown>) => ({
  accountKey: { accountId: "subject-a", issuer: config.issuer },
  protocol: "oidc" as const,
  providerClaims: { email: "same@example.test" },
  providerId: "entra",
  providerReference: {
    authenticationConfigurationFingerprint: "fixture",
    providerId: "entra",
    source: { type: "configured" as const },
  },
  providerUser: {
    email: "same@example.test",
    emailVerified: true,
    name: "Fixture User",
  },
  verifiedIdTokenClaims: {
    iss: config.issuer,
    oid: "object-a",
    sub: "subject-a",
    tid: "tenant-a",
    ...claims,
  },
});

test("OIDC requires verified tenant, issuer, subject, and object claims", async () => {
  const resolve = enterpriseSSO(config).resolveUser;
  assert.ok(resolve);
  const database = {
    findOne: () => Promise.reject(new Error("Must reject before DB access")),
  };
  await Promise.all(
    [
      { iss: "https://login.example.test/other/v2.0" },
      { tid: "tenant-b" },
      { sub: "subject-b" },
      { oid: "" },
    ].map(async (claims) => {
      const result = await resolve(oidcInput(claims), { database } as never);
      assert.deepEqual(result, {
        action: "reject",
        code: "enterprise_identity_mismatch",
      });
    })
  );
});

test("OIDC rejects a persisted provider with the same provider ID", async () => {
  const resolve = enterpriseSSO(config).resolveUser;
  assert.ok(resolve);
  const input = oidcInput({});
  const result = await resolve(
    {
      ...input,
      providerReference: {
        ...input.providerReference,
        source: { recordId: "untrusted-provider", type: "persisted" },
      },
    },
    { database: {} } as never
  );
  assert.deepEqual(result, {
    action: "reject",
    code: "enterprise_provider_mismatch",
  });
});

test("OIDC links only an active SCIM object in the configured company", async () => {
  const resolve = enterpriseSSO(config).resolveUser;
  assert.ok(resolve);
  const calls: {
    model: string;
    where?: { field: string; value: unknown }[];
  }[] = [];
  const source = {
    active: true,
    connectionId: "scim-a",
    connectionUserKey: "key-a",
    externalId: "object-a",
    id: "scim-user-a",
    provisioningDomainId: "company-a",
    userId: "user-a",
  };
  const binding = {
    connectionId: "scim-a",
    decommissionStatus: "active",
    id: "binding-a",
    provisioningDomainId: "company-a",
  };
  const database = {
    findOne: (query: {
      model: string;
      where?: { field: string; value: unknown }[];
    }) => {
      calls.push(query);
      if (query.model === "scimUser") {
        const objectId = query.where?.find(
          (item) => item.field === "externalId"
        )?.value;
        return Promise.resolve(
          objectId === "object-a" ||
            query.where?.some((item) => item.field === "id")
            ? source
            : null
        );
      }
      if (query.model === "scimConnectionBinding") {
        return Promise.resolve(binding);
      }
      if (query.model === "scimIdentityTombstone") {
        return Promise.resolve(null);
      }
      if (query.model === "scimSubject") {
        return Promise.resolve({
          id: "subject-row-a",
          revision: 1,
          userId: "user-a",
        });
      }
      if (query.model === "user") {
        return Promise.resolve({ id: "user-a" });
      }
      return Promise.resolve(null);
    },
    incrementOne: (query: { model: string }) =>
      Promise.resolve(
        query.model === "scimSubject"
          ? { id: "subject-row-a", revision: 2, userId: "user-a" }
          : binding
      ),
  };
  const result = await resolve(oidcInput({}), { database } as never);
  assert.deepEqual(result, {
    action: "link",
    profile: "preserve",
    userId: "user-a",
  });
  assert.ok(
    calls.some(
      (query) =>
        query.model === "scimUser" &&
        query.where?.some(
          (item) => item.field === "externalId" && item.value === "object-a"
        ) &&
        query.where?.some(
          (item) => item.field === "active" && item.value === true
        )
    )
  );
  const unprovisioned = await resolve(oidcInput({ oid: "object-b" }), {
    database,
  } as never);
  assert.deepEqual(unprovisioned, {
    action: "reject",
    code: "enterprise_user_not_provisioned",
  });
});

test("enterprise configuration rejects a generic or mismatched issuer", () => {
  assert.throws(
    () =>
      parseEnterpriseIdentityConfig({
        ...config,
        issuer: "https://login.example.test/common/v2.0",
      }),
    /configured tenant/u
  );
  assert.throws(
    () =>
      parseEnterpriseIdentityConfig({
        ...config,
        issuer: "https://login.example.test/common/v2.0",
        tenantId: "common",
      }),
    /configured tenant/u
  );
  assert.throws(
    () =>
      parseEnterpriseIdentityConfig({
        ...config,
        issuer: "http://login.example.test/tenant-a/v2.0",
      }),
    /HTTPS/u
  );
  assert.throws(() => parseEnterpriseIdentityJSON("{"), /JSON is invalid/u);
  assert.deepEqual(parseEnterpriseIdentityJSON(JSON.stringify(config)), config);
});
