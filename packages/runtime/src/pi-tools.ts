import type { AuthorityService } from "@cerebro/contracts/authority-service";
import type { DurableHandoff } from "@cerebro/contracts/execution";
import { Conflict, Denied } from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { RunId } from "@cerebro/contracts/identity";
import type { ReadOptions } from "@cerebro/contracts/port";
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
  // An idempotent tool may be dispatched again after an interrupted attempt.
  readonly idempotent?: boolean;
}
export interface PiToolConfiguration {
  readonly agent: AgentDefinition;
  readonly tools: readonly PiRegisteredTool[];
  readonly authority: AuthorityService;
  readonly executor: ToolExecutor;
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
  // Makes committed Pi state durable on the host before an external effect.
  readonly persist: () => Effect.Effect<void, ContractFailure>;
  readonly deadlineMs: number;
}

// Pi commits each memo with the tool task, so a replay after a crash reads it.
const RUN_MEMO = "cerebro-run";
const DISPATCH_MEMO = "cerebro-dispatch";
const OUTCOME_MEMO = "cerebro-outcome";
// The output is stored in canonical JSON form, as the model receives it.
type RecordedOutcome =
  | { readonly state: "succeeded"; readonly output: string }
  | { readonly state: "failed"; readonly reason: string };
const failureReason = (failure: ContractFailure): string =>
  "reason" in failure ? failure.reason : `${failure.resource} was not found`;

const UNKNOWN_OUTCOME_TEXT =
  "The tool was dispatched but its outcome is unknown. It will not be retried. Tell the user to check the target system.";

const prepareArguments = (registered: PiRegisteredTool, args: unknown) =>
  registered.prepare?.(args) ?? Effect.succeed(args);

interface PendingTool {
  readonly toolState: Omit<ToolState, "state">;
  dispatched: boolean;
  settled: boolean;
}

const settle = (
  configuration: PiToolConfiguration,
  pending: PendingTool | undefined,
  state: "failed" | "unknown-outcome"
) =>
  Effect.gen(function* settleTool() {
    if (!pending || pending.settled) {
      return;
    }
    yield* configuration.publish(pending.toolState.runId, {
      ...pending.toolState,
      state,
      type: "tool",
    });
    pending.settled = true;
  });

const unknownResult = {
  content: [{ text: UNKNOWN_OUTCOME_TEXT, type: "text" as const }],
  isError: true,
};

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
        let pending: PendingTool | undefined;
        const succeeded = (
          toolState: Omit<ToolState, "state">,
          tool: RegisteredTool,
          execution: ToolExecution
        ) =>
          Effect.gen(function* publishSuccess() {
            yield* configuration.publish(toolState.runId, {
              ...toolState,
              dependencies: yield* configuration.dependencies(
                tool,
                toolState.arguments,
                execution
              ),
              output: execution.output,
              state: "succeeded",
              type: "tool",
            });
            if (pending) {
              pending.settled = true;
            }
            return {
              content: [
                {
                  text: canonicalToolArguments(execution.output),
                  type: "text" as const,
                },
              ],
            };
          });
        const program = Effect.gen(function* executeControlledTool() {
          const preparedArguments = yield* waitForCaller(
            prepareArguments(registered, args),
            options
          );
          const requiresApproval =
            registered.definition.effect === "write" ||
            registered.requiresApproval;
          let memo = yield* vendorEffect(options, () =>
            api.memo(RUN_MEMO, context)
          );
          if (memo === undefined) {
            const candidate = yield* configuration.resolve();
            memo = yield* vendorEffect(options, () =>
              api.memo(RUN_MEMO, candidate.submission.runId, context)
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
          const toolState = {
            arguments: preparedArguments,
            dependencies: yield* configuration.dependencies(
              tool,
              preparedArguments
            ),
            effect: tool.effect,
            operationId,
            output: null,
            runId,
            toolId: tool.id,
            toolVersion: tool.version,
          };
          pending = {
            dispatched: false,
            settled: false,
            toolState,
          };
          const recorded = yield* vendorEffect(options, () =>
            api.memo<RecordedOutcome>(OUTCOME_MEMO, context)
          );
          if (recorded?.state === "succeeded") {
            return yield* succeeded(toolState, tool, {
              output: JSON.parse(recorded.output),
            });
          }
          if (recorded?.state === "failed") {
            yield* settle(configuration, pending, "failed");
            return {
              content: [{ text: recorded.reason, type: "text" as const }],
              isError: true,
            };
          }
          const interrupted = yield* vendorEffect(options, () =>
            api.memo<string>(DISPATCH_MEMO, context)
          );
          if (interrupted !== undefined && !registered.idempotent) {
            yield* settle(configuration, pending, "unknown-outcome");
            return unknownResult;
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
          // The dispatch memo is durable before the effect starts. A replay that
          // finds it without an outcome never dispatches an at-most-once tool again.
          yield* vendorEffect(options, () =>
            api.memo(DISPATCH_MEMO, operationId, context)
          );
          yield* configuration.persist();
          pending.dispatched = true;
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
          // Recording the outcome is best effort: without it a replay reports an
          // unknown outcome, which is safe. A failure here must not turn a
          // confirmed success into a failed tool.
          yield* vendorEffect(options, () =>
            api.memo<RecordedOutcome>(
              OUTCOME_MEMO,
              {
                output: canonicalToolArguments(execution.output),
                state: "succeeded",
              },
              context
            )
          ).pipe(Effect.andThen(configuration.persist()), Effect.ignore);
          return yield* succeeded(toolState, tool, execution);
        });
        return await Effect.runPromise(
          program.pipe(
            Effect.catch((error) =>
              Effect.uninterruptible(
                Effect.gen(function* persistFailure() {
                  if (error._tag === "UnknownOutcome") {
                    yield* settle(configuration, pending, "unknown-outcome");
                    return unknownResult;
                  }
                  if (pending?.dispatched) {
                    // The executor reported a definite failure; a replay repeats it.
                    yield* vendorEffect(
                      { deadlineAt: Date.now() + 30_000 },
                      () =>
                        api.memo<RecordedOutcome>(
                          OUTCOME_MEMO,
                          { reason: failureReason(error), state: "failed" },
                          context
                        )
                    ).pipe(Effect.ignore);
                  }
                  yield* settle(configuration, pending, "failed");
                  return yield* Effect.fail(error);
                })
              )
            ),
            Effect.onInterrupt(() =>
              settle(
                configuration,
                pending,
                pending?.dispatched ? "unknown-outcome" : "failed"
              ).pipe(Effect.ignore)
            )
          ),
          { signal: context.abortSignal }
        );
      },
      name: registered.definition.id,
      parameters: registered.parameters,
      // Replay re-enters the memo guard; an at-most-once tool never dispatches twice.
      replay: "safe" as const,
    }));
