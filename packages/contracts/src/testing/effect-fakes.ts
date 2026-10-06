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
import type { ExecutionContext } from "../identity.ts";
import type { AuthorizationDecision } from "../policy.ts";
import type { EffectOptions, ReadOptions } from "../port.ts";
import { ToolReceiptStore } from "../receipt-service.ts";
import type {
  EffectIntent,
  ReceiptKey,
  ToolReceipt,
} from "../receipt-service.ts";
import { boundApprovalMatches, ToolExecutor } from "../tool-service.ts";
import { canonicalToolArguments, toolCapabilityMatches } from "../tools.ts";

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
const keyOf = (key: ReceiptKey) =>
  JSON.stringify([key.organizationId, key.operationId]);
const intentOf = (intent: EffectIntent) => canonicalToolArguments(intent);
const unresolvedIntentKey = (intent: EffectIntent) => {
  const { invocation } = intent;
  return canonicalToolArguments({
    actorId: invocation.context.actor.id,
    agentId: invocation.agentId,
    argumentDigest: invocation.argumentDigest,
    connectorFingerprint: invocation.tool.connectorFingerprint,
    delegationId: invocation.context.delegation?.id ?? null,
    effect: invocation.tool.effect,
    organizationId: invocation.organizationId,
    principalId:
      invocation.context.represented?.id ?? invocation.context.actor.id,
    runId: invocation.runId,
    toolId: invocation.tool.id,
    toolVersion: invocation.tool.version,
  });
};
export const createReceiptFake = (now: () => number) => {
  const receipts = new Map<string, ToolReceipt>();
  let allowed = true;
  const check = (
    options: ReadOptions,
    organizationId: ReceiptKey["organizationId"],
    context: ExecutionContext
  ) => {
    checkDeadline(options, now());
    if (
      !allowed ||
      !isExecutionContextActiveAt(context, organizationId, now())
    ) {
      throw new Denied({
        code: "unauthorized",
        reason: "Current access denied",
      });
    }
  };
  const read = (key: ReceiptKey, options: EffectOptions) => {
    const receipt = receipts.get(keyOf(key));
    if (!receipt) {
      throw new NotFound({ resource: "tool receipt" });
    }
    check(options, key.organizationId, receipt.intent.invocation.context);
    if (
      options.operationId !== key.operationId ||
      options.requestDigest !== receipt.intent.invocation.argumentDigest
    ) {
      throw new Conflict({
        code: "digest-mismatch",
        reason: "Receipt identity changed",
      });
    }
    return receipt;
  };
  const save = (receipt: ToolReceipt) => {
    receipts.set(keyOf(receipt.key), structuredClone(receipt));
    return structuredClone(receipt);
  };
  const service: ToolReceiptStore = {
    claim: (intent, options) =>
      contractEffect(() => {
        const { invocation } = intent;
        check(options, invocation.organizationId, invocation.context);
        if (
          options.operationId !== invocation.operationId ||
          options.requestDigest !== invocation.argumentDigest
        ) {
          throw new Conflict({
            code: "digest-mismatch",
            reason: "Claim identity changed",
          });
        }
        const key = {
          operationId: invocation.operationId,
          organizationId: invocation.organizationId,
        };
        const unresolved = [...receipts.values()].find(
          (receipt) =>
            receipt.state === "unknown" &&
            unresolvedIntentKey(receipt.intent) === unresolvedIntentKey(intent)
        );
        if (unresolved) {
          throw new UnknownOutcome({
            operationId: unresolved.key.operationId,
            reason: "Unresolved effect intent blocks a new occurrence",
          });
        }
        const prior = receipts.get(keyOf(key));
        if (prior) {
          if (intentOf(prior.intent) !== intentOf(intent)) {
            throw new Conflict({
              code: "digest-mismatch",
              reason: "Full intent changed",
            });
          }
          return { receipt: structuredClone(prior), replayed: true };
        }
        return {
          receipt: save({
            intent: structuredClone(intent),
            key,
            revision: 1,
            state: "claimed",
          }),
          replayed: false,
        };
      }),
    complete: (key, options) =>
      contractEffect(() => {
        const receipt = read(key, options);
        if (receipt.state === "completed") {
          return structuredClone(receipt);
        }
        if (receipt.state !== "outcome") {
          throw new Conflict({
            code: "version-mismatch",
            reason: "Completion requires outcome",
          });
        }
        return save({
          ...receipt,
          revision: receipt.revision + 1,
          state: "completed",
        });
      }),
    dispatch: (key, revision, approval, options) =>
      Effect.gen(function* dispatch() {
        const receipt = yield* contractEffect(() => read(key, options));
        if (receipt.state === "unknown") {
          return yield* Effect.fail(
            new UnknownOutcome({
              operationId: key.operationId,
              reason: receipt.reason,
            })
          );
        }
        if (receipt.state !== "claimed") {
          return { dispatch: false, receipt };
        }
        if (receipt.intent.invocation.tool.effect === "write") {
          const matches =
            approval &&
            (yield* boundApprovalMatches(
              approval,
              receipt.intent.invocation,
              receipt.intent.policyVersion,
              now()
            ).pipe(
              Effect.mapError(
                () => new InvalidInput({ reason: "Invalid approval" })
              )
            ));
          if (!matches) {
            return yield* Effect.fail(
              new Denied({
                code: "approval-required",
                reason: "Bound approval required",
              })
            );
          }
        }
        // Re-read after the asynchronous digest/approval boundary, then claim atomically.
        return yield* contractEffect(() => {
          const current = read(key, options);
          if (current.state !== "claimed") {
            return { dispatch: false, receipt: current };
          }
          if (current.revision !== revision) {
            throw new Conflict({
              code: "version-mismatch",
              reason: "Receipt revision changed",
            });
          }
          return {
            dispatch: true,
            receipt: save({
              ...current,
              dispatchedAt: now(),
              revision: revision + 1,
              state: "dispatched",
            }),
          };
        });
      }),
    read: (key, context, options) =>
      contractEffect(() => {
        check(options, key.organizationId, context);
        const receipt = receipts.get(keyOf(key));
        if (!receipt) {
          throw new NotFound({ resource: "tool receipt" });
        }
        return structuredClone(receipt);
      }),
    recordOutcome: (key, outcome, options) =>
      contractEffect(() => {
        const receipt = read(key, options);
        if (receipt.state === "outcome" || receipt.state === "completed") {
          if (
            canonicalToolArguments(receipt.outcome) !==
            canonicalToolArguments(outcome)
          ) {
            throw new Conflict({
              code: "already-final",
              reason: "Outcome is immutable",
            });
          }
          return structuredClone(receipt);
        }
        if (receipt.state !== "dispatched" && receipt.state !== "unknown") {
          throw new Conflict({
            code: "version-mismatch",
            reason: "Effect has not been dispatched",
          });
        }
        return save({
          ...receipt,
          outcome: structuredClone(outcome),
          revision: receipt.revision + 1,
          state: "outcome",
        });
      }),
    unknown: (key, reason, providerReceipt, options) =>
      contractEffect(() => {
        const receipt = read(key, options);
        if (receipt.state === "unknown") {
          return structuredClone(receipt);
        }
        if (receipt.state !== "dispatched") {
          throw new Conflict({
            code: "already-final",
            reason: "Only dispatched effects can be uncertain",
          });
        }
        return save({
          ...receipt,
          providerReceipt,
          reason,
          revision: receipt.revision + 1,
          state: "unknown",
        });
      }),
  };
  return {
    layer: Layer.succeed(ToolReceiptStore, service),
    service,
    setAllowed: (value: boolean) => {
      allowed = value;
    },
  };
};
export const createToolFake = (now: () => number) => {
  const counts = { dispatch: 0, reconcile: 0 };
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
    reconcile: (operationId, _context, options) =>
      contractEffect(() => {
        checkDeadline(options, now());
        counts.reconcile += 1;
        throw new UnknownOutcome({
          operationId,
          reason: "No confirmed provider evidence",
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
