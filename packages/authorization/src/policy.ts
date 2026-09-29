import type {
  AuthorizationPolicy,
  ExecutionContext,
  Resource,
} from "@cerebro/contracts";
import type { Action } from "@cerebro/contracts/policy";
import type { ReadOptions } from "@cerebro/contracts/port";
import type {
  AuthorizationSnapshot,
  IdentityGrant,
  IdentityRepository,
} from "@cerebro/db/repositories/identity";

const allows = (
  grants: readonly IdentityGrant[],
  action: Action,
  resource: Resource
): boolean =>
  grants.some(
    (grant) =>
      grant.action === action &&
      grant.resourceKind === resource.kind &&
      (grant.resourceId === resource.id || grant.resourceId === "*")
  );

const scopeAllows = (
  snapshot: AuthorizationSnapshot,
  action: Action,
  resource: Resource
): boolean =>
  snapshot.scopes.some(
    (scope) =>
      scope.action === action &&
      scope.resourceKind === resource.kind &&
      (scope.resourceId === resource.id || scope.resourceId === "*")
  );

const deny = (policyVersion: string, reason: string) => ({
  status: "ok" as const,
  value: { decision: "deny" as const, policyVersion, reason },
});

const delegationIsCurrent = (
  snapshot: AuthorizationSnapshot,
  context: ExecutionContext,
  resource: Resource,
  now: number
): boolean => {
  const { delegation, represented, actor } = snapshot;
  if (!context.delegation || !delegation || !represented || !actor) {
    return false;
  }
  return (
    delegation.id === context.delegation.id &&
    delegation.actorId === actor.id &&
    delegation.representedId === context.represented.id &&
    delegation.organizationId === resource.organizationId &&
    delegation.revokedAt === null &&
    delegation.expiresAt.getTime() > now
  );
};

const exportResourceMatchesOrganization = (
  action: Action,
  resource: Resource
): boolean => {
  if (
    action !== "export" ||
    (resource.kind !== "audit" && resource.kind !== "budget")
  ) {
    return true;
  }
  return resource.id === resource.organizationId;
};

const assess = (
  snapshot: AuthorizationSnapshot,
  context: ExecutionContext,
  action: Action,
  resource: Resource,
  now: number
) => {
  const { actor, represented, policyVersion } = snapshot;
  if (
    !actor ||
    actor.id !== context.actor.id ||
    actor.organizationId !== resource.organizationId ||
    actor.state !== "active" ||
    !snapshot.actorDirectoryActive
  ) {
    return deny(policyVersion, "The actor is not active in this organization.");
  }
  if (resource.organizationId !== context.actor.organizationId) {
    return deny(
      policyVersion,
      "The resource belongs to a different organization."
    );
  }
  if (!exportResourceMatchesOrganization(action, resource)) {
    return deny(
      policyVersion,
      "The export resource does not match this organization."
    );
  }
  if (!allows(snapshot.actorGrants, action, resource)) {
    return deny(policyVersion, "The actor does not have this grant.");
  }
  if (!context.delegation) {
    return {
      status: "ok" as const,
      value: { decision: "allow" as const, policyVersion },
    };
  }
  if (!delegationIsCurrent(snapshot, context, resource, now)) {
    return deny(
      policyVersion,
      "The delegation is missing, expired, or revoked."
    );
  }
  if (
    !represented ||
    represented.state !== "active" ||
    !snapshot.representedDirectoryActive ||
    represented.organizationId !== resource.organizationId ||
    !allows(snapshot.representedGrants, action, resource)
  ) {
    return deny(
      policyVersion,
      "The represented principal does not have this grant."
    );
  }
  if (!scopeAllows(snapshot, action, resource)) {
    return deny(
      policyVersion,
      "The delegation does not cover this action and resource."
    );
  }
  return {
    status: "ok" as const,
    value: { decision: "allow" as const, policyVersion },
  };
};

export const createAuthorizationPolicy = (
  repository: Pick<IdentityRepository, "readSnapshot">,
  now: () => number = Date.now
): AuthorizationPolicy => ({
  async evaluate(
    context: ExecutionContext,
    action: Action,
    resource: Resource,
    options: ReadOptions
  ) {
    const currentTime = now();
    if (options.signal?.aborted) {
      return {
        code: "cancelled",
        reason: "The authorization request was cancelled.",
        status: "unavailable",
      };
    }
    if (
      !Number.isFinite(options.deadlineAt) ||
      options.deadlineAt <= currentTime
    ) {
      return {
        code: "deadline-exceeded",
        reason: "The authorization deadline has passed.",
        status: "unavailable",
      };
    }
    const interrupted = Symbol("authorization-interrupted");
    const { promise: interruption, resolve } =
      Promise.withResolvers<typeof interrupted>();
    const interrupt = () => resolve(interrupted);
    const timeout = setTimeout(
      interrupt,
      Math.min(options.deadlineAt - currentTime, 2_147_483_647)
    );
    options.signal?.addEventListener("abort", interrupt, { once: true });
    if (options.signal?.aborted) {
      interrupt();
    }
    try {
      const snapshot = await Promise.race([
        repository.readSnapshot(
          context.actor.organizationId,
          context.actor.id,
          context.delegation?.id
        ),
        interruption,
      ]);
      const afterRead = now();
      if (options.signal?.aborted) {
        return {
          code: "cancelled",
          reason: "The authorization request was cancelled.",
          status: "unavailable",
        };
      }
      if (snapshot === interrupted || options.deadlineAt <= afterRead) {
        return {
          code: "deadline-exceeded",
          reason: "The authorization deadline has passed.",
          status: "unavailable",
        };
      }
      return assess(snapshot, context, action, resource, afterRead);
    } catch {
      return {
        code: "provider-unavailable",
        reason: "The identity store is unavailable.",
        status: "unavailable",
      };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", interrupt);
    }
  },
});
