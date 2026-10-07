import type {
  AuthorizationPolicy,
  ExecutionContext,
  Resource,
} from "@cerebro/contracts";
import {
  AuthorityService,
  enforceDecision,
} from "@cerebro/contracts/authority-service";
import { InvalidInput, Unavailable } from "@cerebro/contracts/failures";
import { isExecutionContextActiveAt } from "@cerebro/contracts/identity";
import type { Action, AuthorizationDecision } from "@cerebro/contracts/policy";
import type { ReadOptions } from "@cerebro/contracts/port";
import type {
  AuthorizationSnapshot,
  IdentityGrant,
  IdentityRepository,
} from "@cerebro/db/repositories/identity";
import { Effect, Layer, Result } from "effect";

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
    actor.kind !== context.actor.kind ||
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
    represented.id !== context.represented.id ||
    represented.kind !== context.represented.kind ||
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

const evaluateIdentity = (
  repository: Pick<IdentityRepository, "readSnapshot">,
  now: () => number,
  context: ExecutionContext,
  action: Action,
  resource: Resource,
  options: ReadOptions
): Effect.Effect<AuthorizationDecision, InvalidInput | Unavailable> =>
  Effect.tryPromise({
    catch: (cause) =>
      cause instanceof InvalidInput || cause instanceof Unavailable
        ? cause
        : new Unavailable({ reason: "The identity store is unavailable." }),
    async try(effectSignal) {
      const currentTime = now();
      if (!resource.id || !resource.organizationId || !context.actor.id) {
        throw new InvalidInput({
          reason: "Authorization identifiers are required.",
        });
      }
      if (options.signal?.aborted) {
        throw new Unavailable({
          reason: "The authorization request was cancelled.",
        });
      }
      if (
        !Number.isFinite(options.deadlineAt) ||
        options.deadlineAt <= currentTime
      ) {
        throw new Unavailable({
          reason: "The authorization deadline has passed.",
        });
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
      effectSignal.addEventListener("abort", interrupt, { once: true });
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
          throw new Unavailable({
            reason: "The authorization request was cancelled.",
          });
        }
        if (snapshot === interrupted || options.deadlineAt <= afterRead) {
          throw new Unavailable({
            reason: "The authorization deadline has passed.",
          });
        }
        if (
          !isExecutionContextActiveAt(
            context,
            resource.organizationId,
            afterRead
          )
        ) {
          return deny(
            snapshot.policyVersion,
            "The execution context is inactive."
          ).value;
        }
        return assess(snapshot, context, action, resource, afterRead).value;
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", interrupt);
        effectSignal.removeEventListener("abort", interrupt);
      }
    },
  });

export const createAuthorizationService = (
  repository: Pick<IdentityRepository, "readSnapshot">,
  now: () => number = Date.now
): AuthorityService => {
  const service: AuthorityService = {
    evaluate: (request, options) =>
      request.address.organizationId === request.resource.organizationId
        ? evaluateIdentity(
            repository,
            now,
            request.context,
            request.action,
            request.resource,
            options
          )
        : Effect.succeed(
            deny(
              "identity:foreign",
              "The resource belongs to a different session company."
            ).value
          ),
    require: (request, options) =>
      Effect.flatMap(service.evaluate(request, options), (decision) =>
        enforceDecision(request, now(), decision)
      ),
  };
  return service;
};

export const authorizationLayer = (
  repository: Pick<IdentityRepository, "readSnapshot">,
  now: () => number = Date.now
) =>
  Layer.succeed(AuthorityService, createAuthorizationService(repository, now));

// Compatibility for callers that the coordinator migrates during S1-F.
export const createAuthorizationPolicy = (
  repository: Pick<IdentityRepository, "readSnapshot">,
  now: () => number = Date.now
): AuthorizationPolicy => ({
  async evaluate(context, action, resource, options) {
    const result = await Effect.runPromise(
      Effect.result(
        evaluateIdentity(repository, now, context, action, resource, options)
      )
    );
    if (Result.isSuccess(result)) {
      return { status: "ok", value: result.success };
    }
    const { failure } = result;
    if (failure._tag === "InvalidInput") {
      return { reason: failure.reason, status: "invalid-input" };
    }
    if (failure.reason === "The authorization request was cancelled.") {
      return {
        code: "cancelled",
        reason: failure.reason,
        status: "unavailable",
      };
    }
    if (failure.reason === "The authorization deadline has passed.") {
      return {
        code: "deadline-exceeded",
        reason: failure.reason,
        status: "unavailable",
      };
    }
    return {
      code: "provider-unavailable",
      reason: failure.reason,
      status: "unavailable",
    };
  },
});
