import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import type { Database } from "../index";
import {
  scimConnectionBinding,
  scimProjectionGrant,
  scimUser,
  session,
  user,
} from "../schema/auth";
import {
  identityDelegation,
  identityDelegationScope,
  identityGrant,
  identityPolicyRevision,
  identityPrincipal,
  identityRolePermission,
  identitySlackLink,
  identitySlackLinkChallenge,
} from "../schema/identity";

export type IdentityPrincipal = typeof identityPrincipal.$inferSelect;
export type IdentityGrant = typeof identityGrant.$inferSelect;
export type IdentityDelegation = typeof identityDelegation.$inferSelect;
export type IdentityDelegationScope =
  typeof identityDelegationScope.$inferSelect;
export type IdentitySlackLink = typeof identitySlackLink.$inferSelect;
export type Permission = Pick<
  IdentityGrant,
  "action" | "resourceKind" | "resourceId"
>;
export type DelegationScope = Pick<
  IdentityDelegationScope,
  "action" | "resourceKind" | "resourceId"
>;
type IdentityTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

export interface AuthorizationSnapshot {
  readonly actor: IdentityPrincipal | undefined;
  readonly represented: IdentityPrincipal | undefined;
  readonly delegation: IdentityDelegation | undefined;
  readonly actorGrants: readonly IdentityGrant[];
  readonly representedGrants: readonly IdentityGrant[];
  readonly actorDirectoryActive: boolean;
  readonly representedDirectoryActive: boolean;
  readonly scopes: readonly IdentityDelegationScope[];
  readonly policyVersion: string;
}

export interface IdentityRepository {
  readonly provisionHumanPrincipal: (
    organizationId: string,
    betterAuthUserId: string
  ) => Promise<IdentityPrincipal>;
  readonly findPrincipalByUser: (
    organizationId: string,
    betterAuthUserId: string
  ) => Promise<IdentityPrincipal | undefined>;
  readonly setPrincipalActive: (
    organizationId: string,
    principalId: string,
    active: boolean
  ) => Promise<void>;
  readonly setManualGrant: (
    organizationId: string,
    principalId: string,
    permission: Permission,
    enabled: boolean
  ) => Promise<void>;
  readonly setRolePermissions: (
    organizationId: string,
    roleId: string,
    permissions: readonly Permission[]
  ) => Promise<void>;
  readonly createDelegation: (input: {
    organizationId: string;
    actorId: string;
    representedId: string;
    expiresAt: Date;
    scopes: readonly DelegationScope[];
  }) => Promise<IdentityDelegation>;
  readonly revokeDelegation: (
    organizationId: string,
    delegationId: string
  ) => Promise<void>;
  readonly createSlackLinkChallenge: (
    organizationId: string,
    principalId: string,
    digest: string,
    expiresAt: Date
  ) => Promise<string>;
  readonly consumeSlackLinkChallenge: (
    organizationId: string,
    digest: string,
    workspaceId: string,
    slackUserId: string,
    now: Date
  ) => Promise<IdentitySlackLink | undefined>;
  readonly resolveSlackLink: (
    workspaceId: string,
    slackUserId: string
  ) => Promise<IdentitySlackLink | undefined>;
  readonly readSnapshot: (
    organizationId: string,
    actorId: string,
    delegationId?: string
  ) => Promise<AuthorizationSnapshot>;
}

const validatePermission = (permission: Permission): void => {
  if (
    !permission.resourceId ||
    permission.resourceId.trim() !== permission.resourceId
  ) {
    throw new Error(
      "A permission needs a resource ID without surrounding whitespace."
    );
  }
  if (
    permission.resourceId === "*" &&
    !(permission.action === "export" && permission.resourceKind === "audit")
  ) {
    throw new Error(
      "Wildcard access is limited to organization-wide audit export."
    );
  }
};

const digestState = async (state: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
};

const bumpVersion = async (
  tx: IdentityTransaction,
  organizationId: string
): Promise<void> => {
  await tx
    .insert(identityPolicyRevision)
    .values({ organizationId, version: 1 })
    .onConflictDoUpdate({
      set: { version: sql`${identityPolicyRevision.version} + 1` },
      target: identityPolicyRevision.organizationId,
    });
};

const requirePrincipal = async (
  tx: IdentityTransaction,
  organizationId: string,
  principalId: string
): Promise<IdentityPrincipal> => {
  const [principal] = await tx
    .select()
    .from(identityPrincipal)
    .where(
      and(
        eq(identityPrincipal.organizationId, organizationId),
        eq(identityPrincipal.id, principalId)
      )
    );
  if (!principal) {
    throw new Error("The principal does not belong to this organization.");
  }
  return principal;
};

const loadGrants = async (
  tx: IdentityTransaction,
  organizationId: string,
  principal: IdentityPrincipal | undefined
) => {
  if (!principal) {
    return {
      directoryActive: false,
      directoryState: "missing",
      grants: [] as IdentityGrant[],
    };
  }
  const direct = await tx
    .select()
    .from(identityGrant)
    .where(
      and(
        eq(identityGrant.organizationId, organizationId),
        eq(identityGrant.principalId, principal.id)
      )
    );
  if (!principal.directoryManaged) {
    return { directoryActive: true, directoryState: "local", grants: direct };
  }
  if (!principal.betterAuthUserId) {
    return {
      directoryActive: false,
      directoryState: "unbound",
      grants: direct,
    };
  }
  const directoryUsers = await tx
    .select()
    .from(scimUser)
    .where(
      and(
        eq(scimUser.userId, principal.betterAuthUserId),
        eq(scimUser.provisioningDomainId, organizationId)
      )
    );
  const connectionIds = [
    ...new Set(directoryUsers.map((entry) => entry.connectionId)),
  ];
  const bindings =
    connectionIds.length > 0
      ? await tx
          .select()
          .from(scimConnectionBinding)
          .where(
            and(
              eq(scimConnectionBinding.provisioningDomainId, organizationId),
              inArray(scimConnectionBinding.connectionId, connectionIds)
            )
          )
      : [];
  const activeBindingIds = new Set(
    bindings
      .filter((binding) => binding.decommissionStatus === "active")
      .map((binding) => binding.connectionId)
  );
  const activeConnections = directoryUsers
    .filter((entry) => entry.active && activeBindingIds.has(entry.connectionId))
    .map((entry) => entry.connectionId);
  const bindingState = bindings.map((binding) => [
    binding.connectionId,
    binding.decommissionStatus,
  ]);
  if (activeConnections.length === 0) {
    return {
      directoryActive: false,
      directoryState: [
        ...directoryUsers.map((entry) => [entry.connectionId, entry.active]),
        ...bindingState,
      ],
      grants: direct,
    };
  }
  const projections = await tx
    .select()
    .from(scimProjectionGrant)
    .where(
      and(
        eq(scimProjectionGrant.userId, principal.betterAuthUserId),
        eq(scimProjectionGrant.provisioningDomainId, organizationId),
        inArray(scimProjectionGrant.connectionId, activeConnections)
      )
    );
  const roles = [...new Set(projections.map((entry) => entry.role))];
  const permissions =
    roles.length > 0
      ? await tx
          .select()
          .from(identityRolePermission)
          .where(
            and(
              eq(identityRolePermission.organizationId, organizationId),
              inArray(identityRolePermission.roleId, roles)
            )
          )
      : [];
  const derived: IdentityGrant[] = [];
  for (const projection of projections) {
    for (const permission of permissions) {
      if (permission.roleId !== projection.role) {
        continue;
      }
      derived.push({
        action: permission.action,
        organizationId,
        principalId: principal.id,
        resourceId: permission.resourceId,
        resourceKind: permission.resourceKind,
        source: `scim:${projection.sourceKind}:${projection.sourceId}`,
      });
    }
  }
  const directoryState = [
    ...directoryUsers.map((entry) => [entry.connectionId, entry.active]),
    ...bindingState,
    ...projections.map((entry) => [
      entry.connectionId,
      entry.sourceKind,
      entry.sourceId,
      entry.sourceValue,
      entry.role,
    ]),
  ]
    .map((entry) => JSON.stringify(entry))
    .toSorted();
  return {
    directoryActive: true,
    directoryState,
    grants: [...direct, ...derived],
  };
};

export const createIdentityRepository = (
  database: Pick<Database, "select" | "transaction">
): IdentityRepository => {
  const readSnapshot = (
    organizationId: string,
    actorId: string,
    delegationId?: string
  ): Promise<AuthorizationSnapshot> =>
    database.transaction(
      async (tx) => {
        const [actor] = await tx
          .select()
          .from(identityPrincipal)
          .where(
            and(
              eq(identityPrincipal.organizationId, organizationId),
              eq(identityPrincipal.id, actorId)
            )
          );
        const [delegation] = delegationId
          ? await tx
              .select()
              .from(identityDelegation)
              .where(
                and(
                  eq(identityDelegation.organizationId, organizationId),
                  eq(identityDelegation.id, delegationId)
                )
              )
          : [];
        const [represented] = delegation
          ? await tx
              .select()
              .from(identityPrincipal)
              .where(
                and(
                  eq(identityPrincipal.organizationId, organizationId),
                  eq(identityPrincipal.id, delegation.representedId)
                )
              )
          : [];
        const actorAccess = await loadGrants(tx, organizationId, actor);
        const representedAccess = await loadGrants(
          tx,
          organizationId,
          represented
        );
        const scopes = delegation
          ? await tx
              .select()
              .from(identityDelegationScope)
              .where(eq(identityDelegationScope.delegationId, delegation.id))
          : [];
        const [revision] = await tx
          .select()
          .from(identityPolicyRevision)
          .where(eq(identityPolicyRevision.organizationId, organizationId));
        const fingerprint = await digestState({
          actor,
          actorDirectory: actorAccess.directoryState,
          actorGrants: actorAccess.grants
            .map((grant) => [
              grant.action,
              grant.resourceKind,
              grant.resourceId,
              grant.source,
            ])
            .toSorted(),
          delegation,
          represented,
          representedDirectory: representedAccess.directoryState,
          representedGrants: representedAccess.grants
            .map((grant) => [
              grant.action,
              grant.resourceKind,
              grant.resourceId,
              grant.source,
            ])
            .toSorted(),
          revision: revision?.version ?? 0,
          scopes: scopes
            .map((scope) => [
              scope.action,
              scope.resourceKind,
              scope.resourceId,
            ])
            .toSorted(),
        });
        return {
          actor,
          actorDirectoryActive: actorAccess.directoryActive,
          actorGrants: actorAccess.grants,
          delegation,
          policyVersion: `identity:${organizationId}:${fingerprint}`,
          represented,
          representedDirectoryActive: representedAccess.directoryActive,
          representedGrants: representedAccess.grants,
          scopes,
        };
      },
      { isolationLevel: "repeatable read" }
    );

  return {
    consumeSlackLinkChallenge(
      organizationId,
      digest,
      workspaceId,
      slackUserId,
      now
    ) {
      return database.transaction(async (tx) => {
        const [challenge] = await tx
          .update(identitySlackLinkChallenge)
          .set({ consumedAt: now })
          .where(
            and(
              eq(identitySlackLinkChallenge.organizationId, organizationId),
              eq(identitySlackLinkChallenge.digest, digest),
              isNull(identitySlackLinkChallenge.consumedAt),
              gt(identitySlackLinkChallenge.expiresAt, now)
            )
          )
          .returning();
        if (!challenge) {
          return;
        }
        const principal = await requirePrincipal(
          tx,
          organizationId,
          challenge.principalId
        );
        const currentAccess = await loadGrants(tx, organizationId, principal);
        if (
          principal.state !== "active" ||
          !currentAccess.directoryActive ||
          principal.betterAuthUserId !== challenge.betterAuthUserId
        ) {
          throw new Error(
            "The challenge principal is no longer active or linked to the same user."
          );
        }
        const [existing] = await tx
          .select()
          .from(identitySlackLink)
          .where(
            and(
              eq(identitySlackLink.workspaceId, workspaceId),
              eq(identitySlackLink.slackUserId, slackUserId)
            )
          );
        if (existing) {
          throw new Error("The Slack identity is already linked.");
        }
        const [link] = await tx
          .insert(identitySlackLink)
          .values({
            id: crypto.randomUUID(),
            organizationId,
            principalId: principal.id,
            slackUserId,
            workspaceId,
          })
          .returning();
        if (!link) {
          throw new Error("The Slack identity could not be linked.");
        }
        return link;
      });
    },
    createDelegation(input) {
      for (const scope of input.scopes) {
        validatePermission(scope);
      }
      return database.transaction(async (tx) => {
        await requirePrincipal(tx, input.organizationId, input.actorId);
        await requirePrincipal(tx, input.organizationId, input.representedId);
        if (
          input.scopes.length === 0 ||
          input.expiresAt.getTime() <= Date.now()
        ) {
          throw new Error("A delegation needs scopes and a future expiry.");
        }
        const [delegation] = await tx
          .insert(identityDelegation)
          .values({
            actorId: input.actorId,
            expiresAt: input.expiresAt,
            id: crypto.randomUUID(),
            organizationId: input.organizationId,
            representedId: input.representedId,
          })
          .returning();
        if (!delegation) {
          throw new Error("The delegation could not be created.");
        }
        await tx
          .insert(identityDelegationScope)
          .values(
            input.scopes.map((scope) => ({
              delegationId: delegation.id,
              ...scope,
            }))
          )
          .onConflictDoNothing();
        await bumpVersion(tx, input.organizationId);
        return delegation;
      });
    },
    createSlackLinkChallenge(organizationId, principalId, digest, expiresAt) {
      if (
        !/^[a-f0-9]{64}$/iu.test(digest) ||
        expiresAt.getTime() <= Date.now()
      ) {
        throw new Error(
          "A valid challenge digest and future expiry are required."
        );
      }
      return database.transaction(async (tx) => {
        const principal = await requirePrincipal(
          tx,
          organizationId,
          principalId
        );
        const currentAccess = await loadGrants(tx, organizationId, principal);
        if (
          principal.state !== "active" ||
          !currentAccess.directoryActive ||
          !principal.betterAuthUserId
        ) {
          throw new Error("An active linked Better Auth user is required.");
        }
        const id = crypto.randomUUID();
        await tx.insert(identitySlackLinkChallenge).values({
          betterAuthUserId: principal.betterAuthUserId,
          digest,
          expiresAt,
          id,
          organizationId,
          principalId,
        });
        return id;
      });
    },
    async findPrincipalByUser(organizationId, betterAuthUserId) {
      const [principal] = await database
        .select()
        .from(identityPrincipal)
        .where(
          and(
            eq(identityPrincipal.organizationId, organizationId),
            eq(identityPrincipal.betterAuthUserId, betterAuthUserId)
          )
        );
      return principal;
    },
    provisionHumanPrincipal(organizationId, betterAuthUserId) {
      return database.transaction(async (tx) => {
        const [authUser] = await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.id, betterAuthUserId));
        if (!authUser) {
          throw new Error("The Better Auth user does not exist.");
        }
        await tx
          .insert(identityPrincipal)
          .values({
            betterAuthUserId,
            id: crypto.randomUUID(),
            kind: "human",
            organizationId,
          })
          .onConflictDoNothing();
        const [principal] = await tx
          .select()
          .from(identityPrincipal)
          .where(
            and(
              eq(identityPrincipal.organizationId, organizationId),
              eq(identityPrincipal.betterAuthUserId, betterAuthUserId)
            )
          );
        if (!principal) {
          throw new Error(
            "The Better Auth user could not be mapped to a principal."
          );
        }
        await bumpVersion(tx, organizationId);
        return principal;
      });
    },
    readSnapshot,
    resolveSlackLink(workspaceId, slackUserId) {
      return database.transaction(
        async (tx) => {
          const [link] = await tx
            .select()
            .from(identitySlackLink)
            .where(
              and(
                eq(identitySlackLink.workspaceId, workspaceId),
                eq(identitySlackLink.slackUserId, slackUserId)
              )
            );
          if (!link) {
            return;
          }
          const principal = await requirePrincipal(
            tx,
            link.organizationId,
            link.principalId
          );
          const currentAccess = await loadGrants(
            tx,
            link.organizationId,
            principal
          );
          if (principal.state !== "active" || !currentAccess.directoryActive) {
            return;
          }
          return link;
        },
        { isolationLevel: "repeatable read" }
      );
    },
    async revokeDelegation(organizationId, delegationId) {
      await database.transaction(async (tx) => {
        await tx
          .update(identityDelegation)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(identityDelegation.organizationId, organizationId),
              eq(identityDelegation.id, delegationId)
            )
          );
        await bumpVersion(tx, organizationId);
      });
    },
    async setManualGrant(organizationId, principalId, permission, enabled) {
      validatePermission(permission);
      await database.transaction(async (tx) => {
        await requirePrincipal(tx, organizationId, principalId);
        const key = {
          organizationId,
          principalId,
          ...permission,
          source: "manual",
        };
        if (enabled) {
          await tx.insert(identityGrant).values(key).onConflictDoNothing();
        }
        if (!enabled) {
          await tx
            .delete(identityGrant)
            .where(
              and(
                eq(identityGrant.organizationId, organizationId),
                eq(identityGrant.principalId, principalId),
                eq(identityGrant.action, permission.action),
                eq(identityGrant.resourceKind, permission.resourceKind),
                eq(identityGrant.resourceId, permission.resourceId),
                eq(identityGrant.source, "manual")
              )
            );
        }
        await bumpVersion(tx, organizationId);
      });
    },
    async setPrincipalActive(organizationId, principalId, active) {
      await database.transaction(async (tx) => {
        const principal = await requirePrincipal(
          tx,
          organizationId,
          principalId
        );
        if (principal.directoryManaged) {
          throw new Error(
            "Directory-managed principals must be activated or deactivated through SCIM."
          );
        }
        await tx
          .update(identityPrincipal)
          .set({ state: active ? "active" : "disabled" })
          .where(eq(identityPrincipal.id, principalId));
        if (!active) {
          if (principal.betterAuthUserId) {
            await tx
              .delete(session)
              .where(eq(session.userId, principal.betterAuthUserId));
          }
          await tx
            .update(identitySlackLinkChallenge)
            .set({ consumedAt: new Date() })
            .where(
              and(
                eq(identitySlackLinkChallenge.organizationId, organizationId),
                eq(identitySlackLinkChallenge.principalId, principalId),
                isNull(identitySlackLinkChallenge.consumedAt)
              )
            );
          await tx
            .update(identityDelegation)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(identityDelegation.organizationId, organizationId),
                or(
                  eq(identityDelegation.actorId, principalId),
                  eq(identityDelegation.representedId, principalId)
                )
              )
            );
        }
        await bumpVersion(tx, organizationId);
      });
    },
    async setRolePermissions(organizationId, roleId, permissions) {
      for (const permission of permissions) {
        validatePermission(permission);
      }
      await database.transaction(async (tx) => {
        await bumpVersion(tx, organizationId);
        await tx
          .delete(identityRolePermission)
          .where(
            and(
              eq(identityRolePermission.organizationId, organizationId),
              eq(identityRolePermission.roleId, roleId)
            )
          );
        if (permissions.length > 0) {
          await tx
            .insert(identityRolePermission)
            .values(
              permissions.map((permission) => ({
                organizationId,
                roleId,
                ...permission,
              }))
            )
            .onConflictDoNothing();
        }
      });
    },
  };
};
