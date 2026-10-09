import { Effect, Layer, Stream } from "effect";

import { AuthorityService, enforceDecision } from "../authority-service.ts";
import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
  UnknownOutcome,
} from "../failures.ts";
import type { ContractFailure } from "../failures.ts";
import { isExecutionContextActiveAt } from "../identity.ts";
import type { AuthorizationDecision } from "../policy.ts";
import type { ReadOptions } from "../port.ts";
import { ToolExecutor } from "../tool-service.ts";
import { toolCapabilityMatches } from "../tools.ts";

const contractEffect = <A>(run: () => A): Effect.Effect<A, ContractFailure> =>
  Effect.try({
    catch: (cause) =>
      cause instanceof Conflict ||
      cause instanceof Denied ||
      cause instanceof InvalidInput ||
      cause instanceof NotFound ||
      cause instanceof Unavailable ||
      cause instanceof UnknownOutcome
        ? cause
        : new InvalidInput({ reason: String(cause) }),
    try: run,
  });
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
export const createToolFake = (now: () => number) => {
  const counts = { dispatch: 0 };
  let allowed = true;
  const service: ToolExecutor = {
    execute: (call, capability, options) =>
      Effect.gen(function* execute() {
        if (
          !allowed ||
          capability.runId !== call.runId ||
          capability.connectorFingerprint !== call.tool.connectorFingerprint
        ) {
          return yield* Effect.fail(
            new Denied({
              code: "unauthorized",
              reason: "Capability binding denied",
            })
          );
        }
        const matches = yield* Effect.tryPromise({
          catch: () => new InvalidInput({ reason: "Invalid arguments" }),
          try: () => toolCapabilityMatches(capability, call, options, now()),
        });
        return yield* contractEffect(() => {
          checkDeadline(options, now());
          if (!allowed || !matches) {
            throw new Denied({
              code: "unauthorized",
              reason: "Current authority denied",
            });
          }
          counts.dispatch += 1;
          return {
            output: "fixture result",
            providerReceipt: "fixture receipt",
          };
        });
      }),
  };
  return {
    counts,
    layer: Layer.succeed(ToolExecutor, service),
    service,
    setAllowed: (value: boolean) => {
      allowed = value;
    },
  };
};
// Scoped observer fake for protocol owners; closing it has no command side effect.
export const fakeObservations = <A>(values: readonly A[]) =>
  Stream.fromIterable(values);
