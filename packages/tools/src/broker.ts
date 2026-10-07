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
import {
  id,
  isExecutionContextActiveAt,
  sameExecutionContext,
} from "@cerebro/contracts/identity";
import type {
  ExecutionContext,
  OperationId,
} from "@cerebro/contracts/identity";
import type { ToolOperationJournal } from "@cerebro/contracts/operation-journal";
import type {
  AuthorizationPolicy,
  EntitlementPolicy,
} from "@cerebro/contracts/policy";
import { preflightEffect } from "@cerebro/contracts/port";
import type {
  EffectOptions,
  PortResult,
  ReadOptions,
} from "@cerebro/contracts/port";
import type {
  ToolReceiptStore,
  ToolReceipt,
} from "@cerebro/contracts/receipt-service";
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
  approvalMatches,
  digestToolArguments,
  canonicalToolArguments,
  toolCapabilityMatches,
} from "@cerebro/contracts/tools";
import type {
  ToolCall,
  ToolCapability,
  ToolExecution,
  ToolExecutor,
} from "@cerebro/contracts/tools";
import { Effect, Layer } from "effect";
import { z } from "zod";

import { boundToolCallSchema, toolCallSchema } from "./capability.ts";
import type { ToolRegistry } from "./registry.ts";
import { bindRegisteredTool } from "./registry.ts";

export interface ToolBroker {
  readonly invoke: (
    call: ToolCall,
    options: EffectOptions
  ) => Promise<PortResult<ToolExecution>>;
  readonly reconcile: ToolExecutor["reconcile"];
}
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
  readonly receipts: ToolReceiptStore;
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

const maintenance = (options: EffectOptions, now: number): EffectOptions => ({
  deadlineAt: now + 5000,
  operationId: options.operationId,
  requestDigest: options.requestDigest,
});

const callFromInvocation = (invocation: BoundInvocation): BoundToolCall => ({
  agentId: invocation.agentId,
  arguments: invocation.arguments,
  context: invocation.context,
  organizationId: invocation.organizationId,
  runId: invocation.runId,
  tool: invocation.tool,
});

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

const execution = (
  receipt: ToolReceipt
): Effect.Effect<ToolExecution, ContractFailure> => {
  if (receipt.state === "outcome" || receipt.state === "completed") {
    return receipt.outcome.state === "succeeded"
      ? Effect.succeed(structuredClone(receipt.outcome.execution))
      : Effect.fail(new Unavailable({ reason: receipt.outcome.reason }));
  }
  return Effect.fail(
    new UnknownOutcome({
      operationId: receipt.key.operationId,
      reason: "The dispatched effect requires reconciliation.",
    })
  );
};

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
  const requireAuthority = (
    call: BoundToolCall,
    options: ReadOptions,
    action: "execute" | "read" = "execute"
  ) =>
    dependencies.authority.require(
      {
        action,
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
  const deliver = (
    receipt: ToolReceipt,
    context: ExecutionContext,
    options: ReadOptions
  ) =>
    Effect.gen(function* deliverReceipt() {
      const { invocation } = receipt.intent;
      if (!sameExecutionContext(invocation.context, context)) {
        return yield* Effect.fail(
          new Denied({
            code: "unauthorized",
            reason: "The caller does not own this receipt.",
          })
        );
      }
      const call = yield* prepare(callFromInvocation(invocation));
      yield* check(options);
      yield* requireAuthority(call, options, "read");
      return yield* execution(receipt);
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
          const claimed = yield* dependencies.receipts.claim(
            { invocation, policyVersion: capability.policyVersion },
            options
          );
          if (
            claimed.receipt.state === "outcome" ||
            claimed.receipt.state === "completed"
          ) {
            const receipt =
              claimed.receipt.state === "outcome"
                ? yield* dependencies.receipts.complete(
                    claimed.receipt.key,
                    maintenance(options, now())
                  )
                : claimed.receipt;
            return yield* deliver(receipt, call.context, options);
          }
          if (claimed.receipt.state !== "claimed") {
            return yield* execution(claimed.receipt);
          }
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
          const { key } = claimed.receipt;
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* dispatch() {
              yield* restore(check(options));
              const current = yield* restore(requireAuthority(call, options));
              if (current.policyVersion !== capability.policyVersion) {
                return yield* Effect.fail(
                  new Denied({
                    code: "revoked",
                    reason: "Authority changed during the approval wait.",
                  })
                );
              }
              yield* restore(checkApproval(current.policyVersion));
              const dispatched = yield* dependencies.receipts.dispatch(
                key,
                claimed.receipt.revision,
                approval,
                options
              );
              if (!dispatched.dispatch) {
                return yield* deliver(
                  dispatched.receipt,
                  call.context,
                  options
                );
              }
              const persist = () => maintenance(options, now());
              const uncertain = (reason: string) =>
                dependencies.receipts.unknown(
                  key,
                  reason,
                  undefined,
                  persist()
                );
              // Receipt finalizers outlive caller interruption; host persistence is injected.
              const attempt = restore(
                Effect.gen(function* physicalDispatch() {
                  yield* check(options);
                  yield* checkApproval(capability.policyVersion);
                  const currentCapability = yield* Effect.tryPromise({
                    catch: () =>
                      new InvalidInput({
                        reason: "Invalid capability arguments.",
                      }),
                    try: () =>
                      toolCapabilityMatches(capability, call, options, now()),
                  });
                  if (!currentCapability) {
                    return yield* Effect.fail(
                      new Denied({
                        code: "revoked",
                        reason: "The capability expired before dispatch.",
                      })
                    );
                  }
                  const finalPermit = yield* requireAuthority(call, options);
                  if (finalPermit.policyVersion !== capability.policyVersion) {
                    return yield* Effect.fail(
                      new Denied({
                        code: "revoked",
                        reason: "Authority changed before physical dispatch.",
                      })
                    );
                  }
                  yield* check(options);
                  return yield* dependencies.driver.execute(
                    call,
                    capability,
                    options
                  );
                })
              ).pipe(
                Effect.onInterrupt(() =>
                  uncertain("The dispatched tool was interrupted.")
                )
              );
              const result = yield* Effect.result(
                attempt.pipe(
                  Effect.catchDefect(() =>
                    Effect.fail(
                      new UnknownOutcome({
                        operationId: options.operationId,
                        reason: "The driver did not confirm an outcome.",
                      })
                    )
                  )
                )
              );
              if (result._tag === "Failure") {
                const { failure } = result;
                if (
                  failure._tag === "UnknownOutcome" ||
                  failure._tag === "Unavailable"
                ) {
                  yield* uncertain(failure.reason);
                  return yield* Effect.fail(
                    new UnknownOutcome({
                      operationId: options.operationId,
                      reason: failure.reason,
                    })
                  );
                }
                yield* dependencies.receipts.recordOutcome(
                  key,
                  {
                    reason:
                      failure._tag === "NotFound"
                        ? failure.resource
                        : failure.reason,
                    state: "failed",
                  },
                  persist()
                );
                yield* dependencies.receipts.complete(key, persist());

                return yield* Effect.fail(failure);
              }
              const value = yield* validateExecution(
                dependencies.registry,
                call,
                result.success
              ).pipe(
                Effect.mapError(
                  (failure) =>
                    new UnknownOutcome({
                      operationId: options.operationId,
                      reason: failure.reason,
                    })
                ),
                Effect.tapError((failure) => uncertain(failure.reason))
              );
              const saved = yield* dependencies.receipts.recordOutcome(
                key,
                { execution: value, state: "succeeded" },
                persist()
              );
              const completed = yield* dependencies.receipts.complete(
                key,
                persist()
              );
              return yield* deliver(
                completed.state === "completed" ? completed : saved,
                call.context,
                options
              );
            })
          );
        }),
        options,
        now
      ),
    reconcile: (operationId, context, options) =>
      withinOptions(
        Effect.gen(function* reconcile() {
          yield* check(options);
          const key = {
            operationId,
            organizationId: context.actor.organizationId,
          };
          yield* dependencies.authority.require(
            {
              action: "read",
              address,
              context,
              pinnedAgent,
              resource: {
                id: address.agentId,
                kind: "agent",
                organizationId: address.organizationId,
              },
            },
            options
          );
          const receipt = yield* dependencies.receipts.read(
            key,
            context,
            options
          );
          const { invocation } = receipt.intent;
          if (!sameExecutionContext(invocation.context, context)) {
            return yield* Effect.fail(
              new Denied({
                code: "unauthorized",
                reason: "The caller does not own this receipt.",
              })
            );
          }
          const call = yield* prepare(callFromInvocation(invocation));
          yield* requireAuthority(call, options, "read");
          if (receipt.state === "outcome" || receipt.state === "completed") {
            const completed =
              receipt.state === "outcome"
                ? yield* dependencies.receipts.complete(
                    key,
                    maintenance(
                      {
                        ...options,
                        operationId,
                        requestDigest: invocation.argumentDigest,
                      },
                      now()
                    )
                  )
                : receipt;
            return yield* deliver(completed, context, options);
          }
          if (receipt.state !== "unknown" && receipt.state !== "dispatched") {
            return yield* execution(receipt);
          }
          const evidence = yield* dependencies.driver.reconcile(
            operationId,
            context,
            options
          );
          const value = yield* validateExecution(
            dependencies.registry,
            call,
            evidence
          );
          const persistence = maintenance(
            {
              ...options,
              operationId,
              requestDigest: invocation.argumentDigest,
            },
            now()
          );
          yield* dependencies.receipts.recordOutcome(
            key,
            { execution: value, state: "succeeded" },
            persistence
          );
          const completed = yield* dependencies.receipts.complete(
            key,
            persistence
          );
          return yield* deliver(completed, context, options);
        }),
        options,
        now
      ),
  };
  return service;
};

export const controlledToolLayer = (dependencies: ControlledToolDependencies) =>
  Layer.succeed(EffectToolExecutor, createControlledToolExecutor(dependencies));
export const checkToolApproval = async (
  journal: ToolOperationJournal,
  call: ToolCall,
  options: EffectOptions,
  policyVersion: string,
  now: number
): Promise<PortResult<void>> => {
  const approval = await journal.approval(
    call.organizationId,
    options.operationId,
    options
  );
  if (approval.status !== "ok") {
    if (approval.status !== "not-found") {
      return approval;
    }
    return {
      code: "approval-required",
      reason: "A bound approval is required.",
      status: "denied",
    };
  }
  let matches = await approvalMatches(
    approval.value,
    {
      ...call,
      argumentDigest: options.requestDigest,
      operationId: options.operationId,
      state: "requested",
    },
    policyVersion,
    now
  );
  const bound = boundToolCallSchema.safeParse(call);
  if (matches && bound.success) {
    const { value } = approval;
    matches =
      "runId" in value &&
      typeof value.runId === "string" &&
      "connectorFingerprint" in value &&
      typeof value.connectorFingerprint === "string"
        ? await Effect.runPromise(
            boundApprovalMatches(
              {
                ...value,
                connectorFingerprint: id.digest(value.connectorFingerprint),
                runId: id.run(value.runId),
              },
              {
                ...bound.data,
                argumentDigest: options.requestDigest,
                operationId: options.operationId,
                state: "requested",
              },
              policyVersion,
              now
            )
          )
        : false;
  }
  return matches
    ? { status: "ok", value: undefined }
    : {
        code: "approval-required",
        reason: "Approval does not match the current tool request.",
        status: "denied",
      };
};
const intentSchema = z.strictObject({
  call: toolCallSchema,
  fingerprint: z.string(),
  kind: z.literal("tool"),
});
export const createToolBroker = (
  dependencies: ToolAuthority & {
    readonly registry: ToolRegistry;
    readonly executor: ToolExecutor;
    readonly journal: ToolOperationJournal;
    readonly now?: () => number;
  }
): ToolBroker => {
  const now = dependencies.now ?? Date.now;
  const prepare = async (input: ToolCall, options: EffectOptions) => {
    let call: ToolCall;
    try {
      call = dependencies.registry.prepare(input);
    } catch {
      return {
        reason: "Tool arguments or metadata are invalid.",
        status: "invalid-input",
      } as const;
    }
    if ((await digestToolArguments(call.arguments)) !== options.requestDigest) {
      return {
        code: "digest-mismatch",
        reason: "The supplied digest does not match normalized arguments.",
        status: "conflict",
      } as const;
    }
    const allowed = await authorizeTool(dependencies, call, options, now());
    if (allowed.status !== "ok") {
      return allowed;
    }
    const entry = dependencies.registry.get(call.tool.id);
    if (entry?.requiresApproval) {
      const approved = await checkToolApproval(
        dependencies.journal,
        call,
        options,
        allowed.value.policyVersion,
        now()
      );
      if (approved.status !== "ok") {
        return approved;
      }
    }
    return {
      status: "ok",
      value: { call, policyVersion: allowed.value.policyVersion },
    } as const;
  };
  return {
    async invoke(input, options) {
      const preflight = preflightEffect(options, now());
      if (preflight.status !== "ok") {
        return preflight;
      }
      const prepared = await prepare(input, options);
      if (prepared.status !== "ok") {
        return prepared;
      }
      const { call } = prepared.value;
      const claim = await dependencies.journal.claim(
        {
          operationId: options.operationId,
          organizationId: call.organizationId,
          request: {
            call,
            fingerprint: dependencies.registry.get(call.tool.id)?.fingerprint,
            kind: "tool",
          },
          requestDigest: options.requestDigest,
        },
        options
      );
      if (claim.status !== "ok") {
        return claim;
      }
      if (claim.value.state === "completed") {
        return structuredClone(claim.value.result);
      }
      if (claim.value.state === "pending") {
        return {
          operationId: options.operationId,
          reason: "This tool operation requires reconciliation.",
          status: "unknown-outcome",
        };
      }
      const { claimToken } = claim.value;
      const dispatched = await dependencies.journal.dispatch(
        claimToken,
        { toolId: call.tool.id },
        options
      );
      if (dispatched.status !== "ok") {
        return dispatched;
      }
      const capability: ToolCapability = {
        ...(call.context.delegation
          ? { delegationId: call.context.delegation.id }
          : {}),
        actorPrincipalId: call.context.actor.id,
        agentId: call.agentId,
        argumentDigest: options.requestDigest,
        connectorId: call.tool.connectorId,
        effect: call.tool.effect,
        expiresAt: Math.min(options.deadlineAt, now() + 60_000),
        operationId: options.operationId,
        organizationId: call.organizationId,
        principalId: call.context.represented?.id ?? call.context.actor.id,
        toolId: call.tool.id,
        toolVersion: call.tool.version,
      };
      let result: PortResult<ToolExecution>;
      try {
        result = await dependencies.executor.execute(call, capability, options);
      } catch {
        result = {
          operationId: options.operationId,
          reason: "The dispatched tool outcome is unknown.",
          status: "unknown-outcome",
        };
      }
      const persistence = maintenance(options, now());
      if (result.status === "unknown-outcome") {
        const saved = await dependencies.journal.unknown(
          claimToken,
          result.reason,
          persistence
        );
        return saved.status === "ok" ? result : saved;
      }
      const saved = await dependencies.journal.complete(
        claimToken,
        result,
        persistence
      );
      if (saved.status !== "ok") {
        return saved;
      }
      const current = await prepare(call, maintenance(options, now()));
      return current.status === "ok" ? structuredClone(result) : current;
    },
    async reconcile(
      operationId: OperationId,
      context: ExecutionContext,
      options: ReadOptions
    ) {
      const record = await dependencies.journal.read(
        context.actor.organizationId,
        operationId,
        options
      );
      if (record.status !== "ok") {
        return record;
      }
      const intent = intentSchema.safeParse(record.value.intent.request);
      if (
        !intent.success ||
        !sameExecutionContext(intent.data.call.context, context)
      ) {
        return {
          code: "unauthorized",
          reason: "The caller does not own this tool operation.",
          status: "denied",
        };
      }
      if (
        intent.data.fingerprint !==
        dependencies.registry.get(intent.data.call.tool.id)?.fingerprint
      ) {
        return {
          code: "version-mismatch",
          reason: "The tool registration changed after dispatch.",
          status: "conflict",
        };
      }
      const effect = {
        ...options,
        operationId,
        requestDigest: record.value.intent.requestDigest,
      };
      const prepared = await prepare(intent.data.call, effect);
      if (prepared.status !== "ok") {
        return prepared;
      }
      if (record.value.state === "completed") {
        return structuredClone(record.value.result);
      }
      const result = await dependencies.executor.reconcile(
        operationId,
        context,
        options
      );
      if (result.status !== "ok") {
        return result;
      }
      const saved = await dependencies.journal.complete(
        record.value.claimToken,
        result,
        maintenance(effect, now())
      );
      return saved.status === "ok" ? result : saved;
    },
  };
};
