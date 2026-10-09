import { acquireActiveSCIMUserLink } from "@better-auth/scim";
import type { SCIMOptions } from "@better-auth/scim";
import type { SSOOptions } from "@better-auth/sso";
import type { BetterAuthPlugin } from "better-auth";

export interface EnterpriseIdentityConfig {
  organizationId: string;
  tenantId: string;
  issuer: string;
  providerId: string;
  domain: string;
  clientId: string;
  clientSecret: string;
  scimConnectionId: string;
  scimBearerToken: string;
  groupRoles: Readonly<Record<string, readonly string[]>>;
}

export const principalPlugin = {
  id: "cerebro-principal",
  schema: {
    identityDelegation: {
      fields: {
        actorId: { required: true, type: "string" },
        createdAt: { required: true, type: "date" },
        expiresAt: { required: true, type: "date" },
        organizationId: { required: true, type: "string" },
        representedId: { required: true, type: "string" },
        revokedAt: { required: false, type: "date" },
      },
      modelName: "identityDelegation",
    },
    identityPrincipal: {
      fields: {
        betterAuthUserId: { required: false, type: "string" },
        createdAt: { required: true, type: "date" },
        directoryManaged: { required: true, type: "boolean" },
        kind: { required: true, type: "string" },
        organizationId: { required: true, type: "string" },
        state: { required: true, type: "string" },
      },
      modelName: "identityPrincipal",
    },
    identitySlackLinkChallenge: {
      fields: {
        betterAuthUserId: { required: true, type: "string" },
        consumedAt: { required: false, type: "date" },
        digest: { required: true, type: "string" },
        expiresAt: { required: true, type: "date" },
        organizationId: { required: true, type: "string" },
        principalId: { required: true, type: "string" },
      },
      modelName: "identitySlackLinkChallenge",
    },
  },
} as const satisfies BetterAuthPlugin;

const isNonemptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const parseEnterpriseIdentityConfig = (
  value: unknown
): EnterpriseIdentityConfig => {
  if (!isRecord(value)) {
    throw new Error("Enterprise identity configuration must be an object");
  }
  const required = [
    "organizationId",
    "tenantId",
    "issuer",
    "providerId",
    "domain",
    "clientId",
    "clientSecret",
    "scimConnectionId",
    "scimBearerToken",
  ] as const;
  for (const field of required) {
    if (!isNonemptyString(value[field])) {
      throw new Error(`Enterprise identity configuration requires ${field}`);
    }
  }
  if (
    !isRecord(value.groupRoles) ||
    !Object.entries(value.groupRoles).every(
      ([groupId, roles]) =>
        groupId.length > 0 &&
        Array.isArray(roles) &&
        roles.every(isNonemptyString)
    )
  ) {
    throw new Error(
      "Enterprise group roles must map stable group IDs to role IDs"
    );
  }
  let issuer: URL;
  try {
    issuer = new URL(value.issuer as string);
  } catch {
    throw new Error("Enterprise issuer must be a valid URL");
  }
  const isLoopbackIssuer =
    issuer.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname);
  if (issuer.protocol !== "https:" && !isLoopbackIssuer) {
    throw new Error("Enterprise issuer must use HTTPS outside loopback");
  }
  if (
    ["common", "organizations", "consumers"].includes(
      value.tenantId as string
    ) ||
    issuer.pathname !== `/${value.tenantId}/v2.0` ||
    issuer.search ||
    issuer.hash
  ) {
    throw new Error(
      "Enterprise issuer must name the configured tenant and OIDC v2.0"
    );
  }
  return value as unknown as EnterpriseIdentityConfig;
};

export const parseEnterpriseIdentityJSON = (
  json: string
): EnterpriseIdentityConfig => {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Enterprise identity JSON is invalid");
  }
  return parseEnterpriseIdentityConfig(value);
};

export const enterpriseSSO = (
  config: EnterpriseIdentityConfig
): SSOOptions => ({
  defaultSSO: [
    {
      domain: config.domain,
      oidcConfig: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        discoveryEndpoint: `${config.issuer}/.well-known/openid-configuration`,
        issuer: config.issuer,
        pkce: true,
        scopes: ["openid", "profile", "email"],
      },
      providerId: config.providerId,
    },
  ],
  providersLimit: 0,
  resolveUser: async (input, context) => {
    if (
      input.protocol !== "oidc" ||
      input.providerId !== config.providerId ||
      input.providerReference.source.type !== "configured" ||
      input.accountKey.issuer !== config.issuer
    ) {
      return { action: "reject", code: "enterprise_provider_mismatch" };
    }

    const claims = input.verifiedIdTokenClaims;
    if (
      claims.iss !== config.issuer ||
      claims.tid !== config.tenantId ||
      !isNonemptyString(claims.sub) ||
      claims.sub !== input.accountKey.accountId ||
      !isNonemptyString(claims.oid)
    ) {
      return { action: "reject", code: "enterprise_identity_mismatch" };
    }

    const linked = await acquireActiveSCIMUserLink(
      { connectionId: config.scimConnectionId, externalId: claims.oid },
      { database: context.database }
    );
    if (!linked) {
      return { action: "reject", code: "enterprise_user_not_provisioned" };
    }
    const source = await context.database.findOne({
      model: "scimUser",
      where: [{ field: "id", value: linked.scimUserId }],
    });
    if (
      !isRecord(source) ||
      source.provisioningDomainId !== config.organizationId
    ) {
      return { action: "reject", code: "enterprise_organization_mismatch" };
    }
    return { action: "link", profile: "preserve", userId: linked.userId };
  },
});

export const enterpriseSCIM = (
  config: EnterpriseIdentityConfig
): SCIMOptions => {
  const rolesByGroup = new Map(Object.entries(config.groupRoles));
  const knownRoles = new Set(Object.values(config.groupRoles).flat());
  return {
    compatibility: {
      microsoftEntra: { acceptLegacyGroupSchema: true },
    },
    connections: [
      {
        credentials: [
          {
            id: config.scimConnectionId,
            token: config.scimBearerToken,
            type: "bearer",
          },
        ],
        id: config.scimConnectionId,
        provisioningDomainId: config.organizationId,
      },
    ],
    identity: {
      reconcileUser: async (input, context) => {
        const where = [
          { field: "organizationId", value: config.organizationId },
          { field: "betterAuthUserId", value: input.userId },
        ] as const;
        const principal = await context.database.findOne({
          model: "identityPrincipal",
          where: [...where],
        });
        let principalId: string;
        if (isRecord(principal) && typeof principal.id === "string") {
          if (principal.kind !== "human") {
            throw new Error("SCIM cannot manage a non-human principal");
          }
          principalId = principal.id;
          await context.database.update({
            model: "identityPrincipal",
            update: {
              directoryManaged: true,
              state: input.active ? "active" : "disabled",
            },
            where: [{ field: "id", value: principalId }],
          });
        } else {
          const created = await context.database.create({
            data: {
              betterAuthUserId: input.userId,
              createdAt: new Date(),
              directoryManaged: true,
              kind: "human",
              organizationId: config.organizationId,
              state: input.active ? "active" : "disabled",
            },
            model: "identityPrincipal",
          });
          if (!isRecord(created) || typeof created.id !== "string") {
            throw new Error("SCIM principal creation returned no ID");
          }
          principalId = created.id;
        }
        if (!input.active) {
          const revokedAt = new Date();
          await Promise.all(
            (["actorId", "representedId"] as const).map((field) =>
              context.database.updateMany({
                model: "identityDelegation",
                update: { revokedAt },
                where: [
                  { field: "organizationId", value: config.organizationId },
                  { field, value: principalId },
                  { field: "revokedAt", value: null },
                ],
              })
            )
          );
          await context.database.updateMany({
            model: "identitySlackLinkChallenge",
            update: { consumedAt: revokedAt },
            where: [
              { field: "organizationId", value: config.organizationId },
              { field: "principalId", value: principalId },
              { field: "consumedAt", value: null },
            ],
          });
          await context.database.deleteMany({
            model: "session",
            where: [{ field: "userId", value: input.userId }],
          });
        }
      },
    },
    projection: {
      reconcileUser: (input) => {
        if (input.provisioningDomainId !== config.organizationId) {
          throw new Error("SCIM projection domain mismatch");
        }
      },
      roles: {
        exists: (input) => knownRoles.has(input.role),
        map: (input) =>
          input.source.externalId
            ? (rolesByGroup.get(input.source.externalId) ?? [])
            : [],
      },
    },
  };
};
