/* oxlint-disable no-await-in-loop -- Approval waits read the durable company decision until the native task is interrupted. */
import type { AuthorityService } from "@cerebro/contracts/authority-service";
import type { EventAddress } from "@cerebro/contracts/events";
import { Denied } from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { ReadOptions } from "@cerebro/contracts/port";
import type {
  AgentDefinition,
  ContentDependencies,
} from "@cerebro/contracts/session";
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

import type { createApprovalStore } from "./approval-store.ts";
import { vendorEffect, waitForCaller } from "./runtime-ports.ts";

export interface PiRegisteredTool {
  readonly definition: RegisteredTool;
  readonly description: string;
  readonly parameters: TSchema;
  readonly prepare?: (
    value: unknown
  ) => Effect.Effect<unknown, ContractFailure>;
  readonly requiresApproval?: boolean;
  readonly idempotent?: boolean;
}
export interface PiToolConfiguration {
  readonly address: EventAddress;
  readonly agent: AgentDefinition;
  readonly tools: readonly PiRegisteredTool[];
  readonly authority: AuthorityService;
  readonly executor: ToolExecutor;
  readonly ownerContext: () => Effect.Effect<ExecutionContext, ContractFailure>;
  readonly approvals: ReturnType<typeof createApprovalStore>;
  readonly checkDependencies: (
    context: ExecutionContext,
    dependencies: ContentDependencies,
    options: ReadOptions
  ) => Effect.Effect<void, ContractFailure>;
  readonly dependencies: (
    tool: RegisteredTool,
    args: unknown,
    execution?: ToolExecution
  ) => Effect.Effect<ContentDependencies, ContractFailure>;
  readonly persist: () => Effect.Effect<void, ContractFailure>;
  readonly deadlineMs: number;
}

const DISPATCH_MEMO = "cerebro-dispatch";
const OUTCOME_MEMO = "cerebro-outcome";
type RecordedOutcome =
  | { readonly state: "succeeded"; readonly output: string }
  | { readonly state: "failed"; readonly reason: string };
const failureReason = (failure: ContractFailure): string =>
  "reason" in failure ? failure.reason : `${failure.resource} was not found`;
const unknownResult = {
  content: [
    {
      text: "The tool was dispatched but its outcome is unknown. It will not be retried. Check the target system before another attempt.",
      type: "text" as const,
    },
  ],
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
        let dispatched = false;
        let approvalId: string | undefined;
        const program = Effect.gen(function* executeControlledTool() {
          const prepared = yield* waitForCaller(
            registered.prepare?.(args) ?? Effect.succeed(args),
            options
          );
          const executionContext = yield* configuration.ownerContext();
          const tool = registered.definition;
          const runId = id.run(String(api.taskId));
          const operationId = id.operation(
            JSON.stringify([
              configuration.address.organizationId,
              configuration.address.sessionId,
              api.taskId,
              api.callId,
            ])
          );
          const argumentDigest = yield* vendorEffect(options, () =>
            digestToolArguments(prepared)
          );
          const effectOptions = {
            ...options,
            operationId,
            requestDigest: argumentDigest,
          };
          const request = {
            action: "execute" as const,
            address: configuration.address,
            context: executionContext,
            pinnedAgent: configuration.agent,
            resource: {
              id: tool.id,
              kind: "tool" as const,
              organizationId: configuration.address.organizationId,
            },
            tool,
          };
          let permit = yield* configuration.authority.require(request, options);
          yield* configuration.checkDependencies(
            executionContext,
            yield* configuration.dependencies(tool, prepared),
            options
          );
          const recorded = yield* vendorEffect(options, () =>
            api.memo<RecordedOutcome>(OUTCOME_MEMO, context)
          );
          if (recorded?.state === "succeeded") {
            return {
              content: [{ text: recorded.output, type: "text" as const }],
            };
          }
          if (recorded?.state === "failed") {
            return {
              content: [{ text: recorded.reason, type: "text" as const }],
              isError: true,
            };
          }
          const interrupted = yield* vendorEffect(options, () =>
            api.memo<string>(DISPATCH_MEMO, context)
          );
          if (interrupted !== undefined && !registered.idempotent) {
            return unknownResult;
          }
          const invocation: BoundInvocation = {
            agentId: configuration.agent.agentId,
            argumentDigest,
            arguments: prepared,
            context: executionContext,
            operationId,
            organizationId: configuration.address.organizationId,
            runId,
            state: "requested",
            tool,
          };
          if (tool.effect === "write" || registered.requiresApproval) {
            const candidate: BoundApproval = {
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
              organizationId: configuration.address.organizationId,
              policyVersion: permit.policyVersion,
              principalId:
                executionContext.represented?.id ?? executionContext.actor.id,
              runId,
              toolId: tool.id,
              toolVersion: tool.version,
            };
            const retained = yield* vendorEffect(options, () =>
              api.commit(
                () =>
                  configuration.approvals.request(
                    invocation,
                    candidate,
                    api.callId
                  ),
                context
              )
            );
            approvalId = retained.id;
            yield* configuration.persist();
            yield* vendorEffect(options, () =>
              api.details(
                {
                  approvalId: retained.id,
                  state: configuration.approvals.read(retained.id).state,
                },
                context
              )
            );
            let approved = yield* vendorEffect(options, () =>
              api.commit(
                () => configuration.approvals.requireAllowed(retained.id),
                context
              )
            );
            while (!approved) {
              yield* waitForCaller(Effect.sleep(250), options);
              yield* configuration.authority.require(request, options);
              approved = yield* vendorEffect(options, () =>
                api.commit(
                  () => configuration.approvals.requireAllowed(retained.id),
                  context
                )
              );
            }
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
                    reason: "Approval binding failed.",
                  })
              )
            );
            if (!matches) {
              return yield* Effect.fail(
                new Denied({
                  code: "revoked",
                  reason: "Approval no longer matches the current tool call.",
                })
              );
            }
            yield* vendorEffect(options, () =>
              api.details(
                { approvalId: retained.id, state: "allowed" },
                context
              )
            );
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
            organizationId: configuration.address.organizationId,
            policyVersion: permit.policyVersion,
            principalId:
              executionContext.represented?.id ?? executionContext.actor.id,
            runId,
            toolId: tool.id,
            toolVersion: tool.version,
          };
          yield* configuration.checkDependencies(
            executionContext,
            yield* configuration.dependencies(tool, prepared),
            options
          );
          yield* vendorEffect(options, () =>
            api.memo(DISPATCH_MEMO, operationId, context)
          );
          yield* configuration.persist();
          dispatched = true;
          const execution = yield* configuration.executor.execute(
            {
              agentId: configuration.agent.agentId,
              arguments: prepared,
              context: executionContext,
              organizationId: configuration.address.organizationId,
              runId,
              tool,
            },
            capability,
            effectOptions
          );
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
          return {
            content: [
              {
                text: canonicalToolArguments(execution.output),
                type: "text" as const,
              },
            ],
          };
        });
        try {
          return await Effect.runPromise(
            program.pipe(
              Effect.catch((error) => {
                if (error._tag === "UnknownOutcome") {
                  return Effect.succeed(unknownResult);
                }
                if (!dispatched) {
                  return Effect.fail(error);
                }
                return vendorEffect({ deadlineAt: Date.now() + 30_000 }, () =>
                  api.memo<RecordedOutcome>(
                    OUTCOME_MEMO,
                    {
                      reason: failureReason(error),
                      state: "failed",
                    },
                    context
                  )
                ).pipe(Effect.ignore, Effect.andThen(Effect.fail(error)));
              })
            ),
            { signal: context.abortSignal }
          );
        } finally {
          if (approvalId) {
            configuration.approvals.cancel(approvalId);
          }
        }
      },
      name: registered.definition.id,
      parameters: registered.parameters,
      replay: "safe" as const,
    }));
