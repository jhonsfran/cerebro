import { Effect, Layer, Stream } from "effect";

import {
  AuthorityService,
  enforceDecision,
} from "../../packages/contracts/src/authority-service.ts";
import { Unavailable } from "../../packages/contracts/src/failures.ts";
import { isExecutionContextActiveAt } from "../../packages/contracts/src/identity.ts";
import type { AuthorizationDecision } from "../../packages/contracts/src/policy.ts";
import type { ReadOptions } from "../../packages/contracts/src/port.ts";

const checkDeadline = (options: ReadOptions, now: number) => {
  if (
    !Number.isFinite(options.deadlineAt) ||
    options.deadlineAt <= now ||
    options.signal?.aborted
  ) {
    throw new Unavailable({ reason: "Deadline or caller interruption" });
  }
};
export const createAuthorityFake = (now: () => number) => {
  let decision: AuthorizationDecision = {
    decision: "allow",
    policyVersion: "fixture-v1",
  };
  let available = true;
  const service: AuthorityService = {
    evaluate: (request, options) =>
      Effect.try({
        catch: () => new Unavailable({ reason: "Authority unavailable" }),
        try: () => {
          checkDeadline(options, now());
          if (!available) {
            throw new Error("Authority unavailable");
          }
          if (
            !isExecutionContextActiveAt(
              request.context,
              request.address.organizationId,
              now()
            )
          ) {
            return {
              decision: "deny",
              policyVersion: decision.policyVersion,
              reason: "Inactive or foreign principal",
            } as const;
          }
          return decision;
        },
      }),
    require: (request, options) =>
      Effect.flatMap(service.evaluate(request, options), (result) =>
        enforceDecision(request, now(), result)
      ),
  };
  return {
    layer: Layer.succeed(AuthorityService, service),
    service,
    setAvailable: (value: boolean) => {
      available = value;
    },
    setDecision: (value: AuthorizationDecision) => {
      decision = value;
    },
  };
};
// Scoped observer fake for protocol owners; closing it has no command side effect.
export const fakeObservations = <A>(values: readonly A[]) =>
  Stream.fromIterable(values);
