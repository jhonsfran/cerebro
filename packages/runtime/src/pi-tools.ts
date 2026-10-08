import type { AuthorityService } from "@cerebro/contracts/authority-service";
import type { DurableHandoff } from "@cerebro/contracts/execution";
import { Conflict, Denied, UnknownOutcome } from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { ExecutionContext, RunId } from "@cerebro/contracts/identity";
import type { ReadOptions } from "@cerebro/contracts/port";
import type {
  ToolReceipt,
  ToolReceiptStore,
} from "@cerebro/contracts/receipt-service";
import type {
  AgentDefinition,
  ContentDependencies,
} from "@cerebro/contracts/session";
import type {
  DomainUpdate,
  ToolState,
} from "@cerebro/contracts/session-service";
import { boundApprovalMatches } from "@cerebro/contracts/tool-service";
import type {
  BoundApproval,
  BoundCapability,
  BoundInvocation,
  RegisteredTool,
  ToolExecutor,
} from "@cerebro/contracts/tool-service";
import {
  canonicalToolArguments,
  digestToolArguments,
} from "@cerebro/contracts/tools";
import type { ToolExecution } from "@cerebro/contracts/tools";
import type { TSchema } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { Effect } from "effect";

import { vendorEffect, waitForCaller } from "./runtime-ports.ts";

export interface PiRegisteredTool {
  readonly definition: RegisteredTool;
  readonly description: string;
  readonly parameters: TSchema;
  readonly prepare?: (
    argumentsValue: unknown
  ) => Effect.Effect<unknown, ContractFailure>;
  readonly requiresApproval?: boolean;
}
export interface PiToolConfiguration {
  readonly agent: AgentDefinition;
  readonly tools: readonly PiRegisteredTool[];
  readonly authority: AuthorityService;
  readonly executor: ToolExecutor;
  readonly receipts: ToolReceiptStore;
  readonly resolve: (
    runId?: RunId
  ) => Effect.Effect<DurableHandoff, ContractFailure>;
  readonly publish: (
    runId: RunId,
    update: DomainUpdate
  ) => Effect.Effect<void, ContractFailure>;
  readonly approval: (
    invocation: BoundInvocation,
    permit: BoundApproval,
    options: ReadOptions
  ) => Effect.Effect<BoundApproval, ContractFailure>;
  readonly dependencies: (
    tool: RegisteredTool,
    args: unknown,
    execution?: ToolExecution
  ) => Effect.Effect<ContentDependencies, ContractFailure>;
  readonly deadlineMs: number;
}

const hasOutcome = (
  receipt: ToolReceipt
): receipt is Extract<
  ToolReceipt,
  { readonly state: "outcome" | "completed" }
> => receipt.state === "outcome" || receipt.state === "completed";

const prepareArguments = (registered: PiRegisteredTool, args: unknown) =>
  registered.prepare?.(args) ?? Effect.succeed(args);

interface PendingTool {
  readonly toolState: Omit<ToolState, "state">;
  readonly executionContext: ExecutionContext;
  readonly definition: RegisteredTool;
  executorEntered: boolean;
  settled: boolean;
}

const settleFailure = (
  configuration: PiToolConfiguration,
  pending: PendingTool | undefined
) =>
  Effect.gen(function* settleConfirmedFailure() {
    if (!pending || pending.settled) {
      return false;
    }
    let execution: ToolExecution | undefined;
    if (pending.executorEntered) {
      const maintenance = { deadlineAt: Date.now() + 30_000 };
      const result = yield* Effect.result(
        waitForCaller(
          configuration.receipts.read(
            {
              operationId: pending.toolState.operationId,
              organizationId: configuration.agent.organizationId,
            },
            pending.executionContext,
            maintenance
          ),
          maintenance
        )
      );
      if (
        result._tag === "Failure" ||
        result.success.state === "dispatched" ||
        result.success.state === "unknown"
      ) {
        return true;
      }
      if (
        hasOutcome(result.success) &&
        result.success.outcome.state === "succeeded"
      ) {
        ({ execution } = result.success.outcome);
      }
    }
    yield* configuration.publish(pending.toolState.runId, {
      ...pending.toolState,
      ...(execution
        ? {
            dependencies: yield* configuration.dependencies(
              pending.definition,
              pending.toolState.arguments,
              execution
            ),
            output: execution.output,
          }
        : {}),
      state: execution ? "succeeded" : "failed",
      type: "tool",
    });
    pending.settled = true;
    return false;
  });

const blockUnknown = (
  configuration: PiToolConfiguration,
  boundRunId: RunId | undefined,
  failure: UnknownOutcome,
  pending?: PendingTool
) =>
  Effect.gen(function* persistUnknown() {
    const handoff = yield* configuration.resolve(boundRunId);
    if (pending && !pending.settled) {
      yield* configuration.publish(handoff.submission.runId, {
        ...pending.toolState,
        state: "unknown-outcome",
        type: "tool",
      });
      pending.settled = true;
    }
    yield* configuration.publish(handoff.submission.runId, {
      run: {
        operationId: failure.operationId,
        runId: handoff.submission.runId,
        state: "unknown-outcome",
      },
      type: "run",
    });
    return {
      content: [
        {
          text: "Tool outcome is unknown; reconciliation is required",
          type: "text" as const,
        },
      ],
      control: { terminate: true as const },
    };
  });

export const createPiTools = (
  configuration: PiToolConfiguration
): readonly ToolRegistration[] =>
  configuration.tools
    .filter((tool) =>
      configuration.agent.enabledToolIds.includes(tool.definition.id)
    )
    .map((registered) => ({
      description: registered.description,
      execute: async (args, api, context) => {
        const options = {
          deadlineAt: Date.now() + configuration.deadlineMs,
          signal: context.abortSignal,
        };
        let boundRunId: RunId | undefined;
        let pending: PendingTool | undefined;
        const program = Effect.gen(function* executeControlledTool() {
          const preparedArguments = yield* waitForCaller(
            prepareArguments(registered, args),
            options
          );
          const requiresApproval =
            registered.definition.effect === "write" ||
            registered.requiresApproval;
          let memo = yield* vendorEffect(options, () =>
            api.memo("cerebro-run", context)
          );
          if (memo === undefined) {
            const candidate = yield* configuration.resolve();
            memo = yield* vendorEffect(options, () =>
              api.memo("cerebro-run", candidate.submission.runId, context)
            );
          }
          if (typeof memo !== "string") {
            return yield* Effect.fail(
              new Conflict({
                code: "digest-mismatch",
                reason: "Invalid persisted Pi tool binding",
              })
            );
          }
          const handoff = yield* configuration.resolve(id.run(memo));
          const { runId } = handoff.submission;
          boundRunId = runId;
          const tool = registered.definition;
          const operationId = id.operation(
            JSON.stringify([
              handoff.address.organizationId,
              handoff.address.sessionId,
              api.taskId,
              api.callId,
            ])
          );
          const argumentDigest = yield* vendorEffect(options, () =>
            digestToolArguments(preparedArguments)
          );
          const effectOptions = {
            ...options,
            operationId,
            requestDigest: argumentDigest,
          };
          const executionContext = handoff.submission.event.context;
          const request = {
            action: "execute" as const,
            address: handoff.address,
            context: executionContext,
            pinnedAgent: configuration.agent,
            resource: {
              id: tool.id,
              kind: "tool" as const,
              organizationId: handoff.address.organizationId,
            },
            tool,
          };
          let permit = yield* configuration.authority.require(request, options);
          const invocation: BoundInvocation = {
            agentId: configuration.agent.agentId,
            argumentDigest,
            arguments: preparedArguments,
            context: executionContext,
            operationId,
            organizationId: handoff.address.organizationId,
            runId,
            state: "requested",
            tool,
          };
          const initialDependencies = yield* configuration.dependencies(
            tool,
            preparedArguments
          );
          const toolState = {
            arguments: preparedArguments,
            dependencies: initialDependencies,
            effect: tool.effect,
            operationId,
            output: null,
            runId,
            toolId: tool.id,
            toolVersion: tool.version,
          };
          pending = {
            definition: tool,
            executionContext,
            executorEntered: false,
            settled: false,
            toolState,
          };
          const claim = yield* configuration.receipts.claim(
            { invocation, policyVersion: permit.policyVersion },
            effectOptions
          );
          if (
            claim.receipt.state === "unknown" ||
            claim.receipt.state === "dispatched"
          ) {
            if (claim.receipt.state === "dispatched") {
              yield* configuration.receipts.unknown(
                claim.receipt.key,
                "Interrupted dispatch needs provider evidence",
                undefined,
                effectOptions
              );
            }
            return yield* Effect.fail(
              new UnknownOutcome({
                operationId,
                reason:
                  "An earlier dispatch requires evidence-based reconciliation",
              })
            );
          }
          if (hasOutcome(claim.receipt)) {
            if (claim.receipt.outcome.state === "failed") {
              yield* configuration.publish(runId, {
                ...toolState,
                state: "failed",
                type: "tool",
              });
              pending.settled = true;
              return {
                content: [
                  { text: "Controlled tool failed", type: "text" as const },
                ],
                control: { terminate: true as const },
              };
            }
            const { execution } = claim.receipt.outcome;
            yield* configuration.publish(runId, {
              ...toolState,
              dependencies: yield* configuration.dependencies(
                tool,
                preparedArguments,
                execution
              ),
              output: execution.output,
              state: "succeeded",
              type: "tool",
            });
            pending.settled = true;
            return {
              content: [
                {
                  text: canonicalToolArguments(execution.output),
                  type: "text" as const,
                },
              ],
            };
          }
          yield* configuration.publish(runId, {
            ...toolState,
            state: requiresApproval ? "waiting-for-approval" : "requested",
            type: "tool",
          });
          if (requiresApproval) {
            const approval: BoundApproval = {
              actorPrincipalId: executionContext.actor.id,
              agentId: configuration.agent.agentId,
              approverId: executionContext.actor.id,
              argumentDigest,
              connectorFingerprint: tool.connectorFingerprint,
              connectorId: tool.connectorId,
              ...(executionContext.delegation
                ? { delegationId: executionContext.delegation.id }
                : {}),
              effect: tool.effect,
              expiresAt: options.deadlineAt,
              id: `approval:${operationId}`,
              operationId,
              organizationId: handoff.address.organizationId,
              policyVersion: permit.policyVersion,
              principalId:
                executionContext.represented?.id ?? executionContext.actor.id,
              runId,
              toolId: tool.id,
              toolVersion: tool.version,
            };
            const approved = yield* configuration.approval(
              invocation,
              approval,
              options
            );
            permit = yield* configuration.authority.require(request, options);
            const matches = yield* boundApprovalMatches(
              approved,
              invocation,
              permit.policyVersion,
              Date.now()
            ).pipe(
              Effect.mapError(
                () =>
                  new Denied({
                    code: "unauthorized",
                    reason: "Approval binding failed",
                  })
              )
            );
            if (!matches) {
              return yield* Effect.fail(
                new Denied({
                  code: "revoked",
                  reason: "Approval no longer matches the current intent",
                })
              );
            }
          }
          permit = yield* configuration.authority.require(request, options);
          const capability: BoundCapability = {
            actorPrincipalId: executionContext.actor.id,
            agentId: configuration.agent.agentId,
            argumentDigest,
            connectorFingerprint: tool.connectorFingerprint,
            connectorId: tool.connectorId,
            ...(executionContext.delegation
              ? { delegationId: executionContext.delegation.id }
              : {}),
            effect: tool.effect,
            expiresAt: options.deadlineAt,
            operationId,
            organizationId: handoff.address.organizationId,
            policyVersion: permit.policyVersion,
            principalId:
              executionContext.represented?.id ?? executionContext.actor.id,
            runId,
            toolId: tool.id,
            toolVersion: tool.version,
          };
          yield* configuration.publish(runId, {
            ...toolState,
            state: "running",
            type: "tool",
          });
          pending.executorEntered = true;
          const execution = yield* configuration.executor.execute(
            {
              agentId: configuration.agent.agentId,
              arguments: preparedArguments,
              context: executionContext,
              organizationId: handoff.address.organizationId,
              runId,
              tool,
            },
            capability,
            effectOptions
          );
          // S1-B owns dispatch and outcome persistence. A vendor return alone is insufficient.
          const receipt = yield* configuration.receipts.read(
            { operationId, organizationId: handoff.address.organizationId },
            executionContext,
            options
          );
          if (!hasOutcome(receipt) || receipt.outcome.state !== "succeeded") {
            return yield* Effect.fail(
              new UnknownOutcome({
                operationId,
                reason: "Controlled tool outcome is not durably confirmed",
              })
            );
          }
          yield* configuration.publish(runId, {
            ...toolState,
            dependencies: yield* configuration.dependencies(
              tool,
              preparedArguments,
              execution
            ),
            output: receipt.outcome.execution.output,
            state: "succeeded",
            type: "tool",
          });
          pending.settled = true;
          return {
            content: [
              {
                text: canonicalToolArguments(receipt.outcome.execution.output),
                type: "text" as const,
              },
            ],
          };
        });
        return await Effect.runPromise(
          program.pipe(
            Effect.catch((error) =>
              Effect.uninterruptible(
                Effect.gen(function* persistFailure() {
                  if (error._tag === "UnknownOutcome") {
                    return yield* blockUnknown(
                      configuration,
                      boundRunId,
                      error,
                      pending
                    );
                  }
                  if (
                    (yield* settleFailure(configuration, pending)) &&
                    pending
                  ) {
                    const unknown = new UnknownOutcome({
                      operationId: pending.toolState.operationId,
                      reason:
                        "Controlled tool failure has no confirmed dispatch evidence",
                    });
                    return yield* blockUnknown(
                      configuration,
                      boundRunId,
                      unknown,
                      pending
                    );
                  }
                  return yield* Effect.fail(error);
                })
              )
            ),
            Effect.onInterrupt(() =>
              Effect.gen(function* persistInterruption() {
                if (pending && (yield* settleFailure(configuration, pending))) {
                  yield* blockUnknown(
                    configuration,
                    boundRunId,
                    new UnknownOutcome({
                      operationId: pending.toolState.operationId,
                      reason:
                        "Interrupted tool needs confirmed dispatch evidence",
                    }),
                    pending
                  );
                }
              })
            )
          ),
          { signal: context.abortSignal }
        );
      },
      name: registered.definition.id,
      parameters: registered.parameters,
      // Replay re-enters the receipt guard; it never executes a connector directly.
      replay: "safe" as const,
    }));
