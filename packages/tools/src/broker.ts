import type { AuthorityService } from "@cerebro/contracts/authority-service";
import type { EventAddress } from "@cerebro/contracts/events";
import {
  Conflict,
  Denied,
  InvalidInput,
  Unavailable,
  UnknownOutcome,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import { isExecutionContextActiveAt } from "@cerebro/contracts/identity";
import type {
  AuthorizationPolicy,
  EntitlementPolicy,
} from "@cerebro/contracts/policy";
import { preflightEffect } from "@cerebro/contracts/port";
import type { PortResult, ReadOptions } from "@cerebro/contracts/port";
import type { AgentDefinition } from "@cerebro/contracts/session";
import {
  boundApprovalMatches,
  ToolExecutor as EffectToolExecutor,
} from "@cerebro/contracts/tool-service";
import type {
  BoundApproval,
  BoundInvocation,
  BoundToolCall,
} from "@cerebro/contracts/tool-service";
import {
  digestToolArguments,
  canonicalToolArguments,
  toolCapabilityMatches,
} from "@cerebro/contracts/tools";
import type { ToolCall, ToolExecution } from "@cerebro/contracts/tools";
import { Effect, Layer } from "effect";

import { boundToolCallSchema } from "./capability.ts";
import type { ToolRegistry } from "./registry.ts";
import { bindRegisteredTool } from "./registry.ts";

export interface ToolAuthority {
  readonly authorizationPolicy: AuthorizationPolicy;
  readonly entitlementPolicy: EntitlementPolicy;
}
export const authorizeTool = async (
  authority: ToolAuthority,
  call: ToolCall,
  options: ReadOptions,
  now: number
): Promise<PortResult<{ readonly policyVersion: string }>> => {
  if (!isExecutionContextActiveAt(call.context, call.organizationId, now)) {
    return {
      code: "unauthorized",
      reason: "The execution context is inactive.",
      status: "denied",
    };
  }
  const allowed = await authority.authorizationPolicy.evaluate(
    call.context,
    "execute",
    {
      id: call.tool.id,
      kind: "tool",
      organizationId: call.organizationId,
    },
    options
  );
  if (allowed.status !== "ok") {
    return allowed;
  }
  if (allowed.value.decision !== "allow") {
    return {
      code: "unauthorized",
      reason: "Current policy denies this tool.",
      status: "denied",
    };
  }
  const entitled = await authority.entitlementPolicy.check(
    {
      agentId: call.agentId,
      capability: call.tool.id,
      organizationId: call.organizationId,
    },
    options
  );
  if (entitled.status !== "ok") {
    return entitled;
  }
  if (entitled.value.decision !== "allow") {
    return {
      code: "entitlement",
      reason: "This tool capability is not enabled.",
      status: "denied",
    };
  }
  return {
    status: "ok",
    value: { policyVersion: allowed.value.policyVersion },
  };
};

export interface ControlledToolDependencies {
  readonly address: EventAddress;
  readonly pinnedAgent: AgentDefinition;
  readonly authority: AuthorityService;
  readonly registry: ToolRegistry;
  readonly driver: EffectToolExecutor;
  readonly approval: (
    invocation: BoundInvocation,
    options: ReadOptions
  ) => Effect.Effect<BoundApproval | undefined, ContractFailure>;
  readonly checkApprover: (
    approval: BoundApproval,
    invocation: BoundInvocation,
    options: ReadOptions
  ) => Effect.Effect<void, ContractFailure>;
  readonly now?: () => number;
}

const withinOptions = <A>(
  program: Effect.Effect<A, ContractFailure>,
  options: ReadOptions,
  now: () => number
): Effect.Effect<A, ContractFailure> =>
  Effect.suspend(() => {
    const preflight = preflightEffect(options, now());
    if (preflight.status !== "ok") {
      return Effect.fail(
        new Unavailable({
          reason: "The tool deadline or caller signal prevents execution.",
        })
      );
    }
    const bounded = program.pipe(
      Effect.timeoutOrElse({
        duration: Math.max(1, options.deadlineAt - now()),
        orElse: () =>
          Effect.fail(
            new Unavailable({ reason: "The tool request deadline has passed." })
          ),
      })
    );
    const { signal } = options;
    if (!signal) {
      return bounded;
    }
    const cancelled = Effect.callback<never, Unavailable>((resume) => {
      const abort = () =>
        resume(
          Effect.fail(new Unavailable({ reason: "The tool caller cancelled." }))
        );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
      return Effect.sync(() => signal.removeEventListener("abort", abort));
    });
    return Effect.raceFirst(bounded, cancelled);
  });

const validateExecution = (
  registry: ToolRegistry,
  call: BoundToolCall,
  value: ToolExecution
): Effect.Effect<ToolExecution, InvalidInput> =>
  Effect.try({
    catch: () =>
      new InvalidInput({
        reason: "The driver returned invalid or unbounded output.",
      }),
    try: () => {
      const entry = registry.get(call.tool.id);
      if (!entry) {
        throw new Error("Tool is not registered.");
      }
      const output = entry.output.parse(value.output);
      if (
        new TextEncoder().encode(canonicalToolArguments(output)).byteLength >
        entry.maxOutputBytes
      ) {
        throw new Error("Tool output exceeds its bound.");
      }
      return { ...value, output };
    },
  });

export const createControlledToolExecutor = (
  dependencies: ControlledToolDependencies
): EffectToolExecutor => {
  const now = dependencies.now ?? Date.now;
  const address = structuredClone(dependencies.address);
  const pinnedAgent = structuredClone(dependencies.pinnedAgent);
  const check = (options: ReadOptions) =>
    Effect.suspend(() => {
      const preflight = preflightEffect(options, now());
      return preflight.status === "ok"
        ? Effect.void
        : Effect.fail(
            new Unavailable({
              reason:
                "reason" in preflight
                  ? preflight.reason
                  : "The request is unavailable.",
            })
          );
    });
  const requireAuthority = (call: BoundToolCall, options: ReadOptions) =>
    dependencies.authority.require(
      {
        action: "execute",
        address,
        context: call.context,
        pinnedAgent,
        resource: {
          id: call.tool.id,
          kind: "tool",
          organizationId: call.organizationId,
        },
        tool: call.tool,
      },
      options
    );
  const prepare = (value: BoundToolCall) =>
    Effect.gen(function* prepareCall() {
      const input = yield* Effect.try({
        catch: () => new InvalidInput({ reason: "Invalid bound tool call." }),
        try: () => boundToolCallSchema.parse(structuredClone(value)),
      });
      if (
        input.organizationId !== address.organizationId ||
        input.agentId !== address.agentId
      ) {
        return yield* Effect.fail(
          new Denied({
            code: "unauthorized",
            reason: "The tool does not belong to the pinned session.",
          })
        );
      }
      const call = yield* Effect.try({
        catch: () =>
          new InvalidInput({ reason: "Invalid registered tool or arguments." }),
        try: () => dependencies.registry.prepare(structuredClone(input)),
      });
      const entry = dependencies.registry.get(call.tool.id);
      if (!entry) {
        return yield* Effect.fail(
          new InvalidInput({ reason: "Tool is not registered." })
        );
      }
      const tool = yield* bindRegisteredTool(entry);
      if (tool.connectorFingerprint !== input.tool.connectorFingerprint) {
        return yield* Effect.fail(
          new Denied({
            code: "unauthorized",
            reason: "The connector registration changed.",
          })
        );
      }
      return { ...call, runId: input.runId, tool };
    });
  const service: EffectToolExecutor = {
    execute: (input, inputCapability, options) =>
      withinOptions(
        Effect.gen(function* execute() {
          yield* check(options);
          const call = yield* prepare(input);
          const capability = structuredClone(inputCapability);
          const digest = yield* Effect.tryPromise({
            catch: () => new InvalidInput({ reason: "Invalid arguments." }),
            try: () => digestToolArguments(call.arguments),
          });
          if (digest !== options.requestDigest) {
            return yield* Effect.fail(
              new Conflict({
                code: "digest-mismatch",
                reason: "The digest differs from normalized arguments.",
              })
            );
          }
          const matches = yield* Effect.tryPromise({
            catch: () =>
              new InvalidInput({ reason: "Invalid capability arguments." }),
            try: () => toolCapabilityMatches(capability, call, options, now()),
          });
          if (
            !matches ||
            capability.runId !== call.runId ||
            capability.connectorFingerprint !== call.tool.connectorFingerprint
          ) {
            return yield* Effect.fail(
              new Denied({
                code: "unauthorized",
                reason: "The bound capability does not match this call.",
              })
            );
          }
          const permit = yield* requireAuthority(call, options);
          if (capability.policyVersion !== permit.policyVersion) {
            return yield* Effect.fail(
              new Denied({
                code: "revoked",
                reason: "The capability policy is stale.",
              })
            );
          }
          const invocation: BoundInvocation = {
            ...call,
            argumentDigest: options.requestDigest,
            operationId: options.operationId,
            state: "requested",
          };
          const entry = dependencies.registry.get(call.tool.id);
          const needsApproval =
            call.tool.effect === "write" || entry?.requiresApproval;
          const approval = needsApproval
            ? yield* dependencies.approval(invocation, options)
            : undefined;
          const checkApproval = (policyVersion: string) =>
            Effect.gen(function* validateApproval() {
              if (!needsApproval) {
                return;
              }
              if (
                !approval ||
                !(yield* boundApprovalMatches(
                  approval,
                  invocation,
                  policyVersion,
                  now()
                ).pipe(
                  Effect.mapError(
                    () =>
                      new InvalidInput({
                        reason: "Invalid approval arguments.",
                      })
                  )
                ))
              ) {
                return yield* Effect.fail(
                  new Denied({
                    code: "approval-required",
                    reason: "A current bound approval is required.",
                  })
                );
              }
              yield* dependencies.checkApprover(approval, invocation, options);
            });
          yield* checkApproval(permit.policyVersion);
          yield* check(options);
          const current = yield* requireAuthority(call, options);
          if (current.policyVersion !== capability.policyVersion) {
            return yield* Effect.fail(
              new Denied({
                code: "revoked",
                reason: "Authority changed during the approval wait.",
              })
            );
          }
          yield* checkApproval(current.policyVersion);
          const currentCapability = yield* Effect.tryPromise({
            catch: () =>
              new InvalidInput({ reason: "Invalid capability arguments." }),
            try: () => toolCapabilityMatches(capability, call, options, now()),
          });
          if (!currentCapability) {
            return yield* Effect.fail(
              new Denied({
                code: "revoked",
                reason: "The capability expired before dispatch.",
              })
            );
          }
          yield* check(options);
          // Pi records the dispatch; a failure after this point may hide a completed effect.
          const value = yield* dependencies.driver
            .execute(call, capability, options)
            .pipe(
              Effect.catchDefect(() =>
                Effect.fail(
                  new UnknownOutcome({
                    operationId: options.operationId,
                    reason: "The driver did not confirm an outcome.",
                  })
                )
              ),
              Effect.mapError((failure) =>
                failure._tag === "Unavailable"
                  ? new UnknownOutcome({
                      operationId: options.operationId,
                      reason: failure.reason,
                    })
                  : failure
              )
            );
          return yield* validateExecution(
            dependencies.registry,
            call,
            value
          ).pipe(
            Effect.mapError(
              (failure) =>
                new UnknownOutcome({
                  operationId: options.operationId,
                  reason: failure.reason,
                })
            )
          );
        }),
        options,
        now
      ),
  };
  return service;
};
export const controlledToolLayer = (dependencies: ControlledToolDependencies) =>
  Layer.succeed(EffectToolExecutor, createControlledToolExecutor(dependencies));
