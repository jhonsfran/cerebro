/* oxlint-disable no-await-in-loop -- Approval waits read the durable company decision until the native task is interrupted. */
import type {
  ToolAuditEvent,
  ToolCallFacts,
  ToolCallOutcome,
} from "@cerebro/contracts/audit";
import type { AuthorityService } from "@cerebro/contracts/authority-service";
import type { EventAddress } from "@cerebro/contracts/events";
import {
  Denied,
  Unavailable,
  UnknownOutcome,
} from "@cerebro/contracts/failures";
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
import type { MetadataTransaction } from "./session-agent.ts";

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
  readonly metadata: MetadataTransaction;
  readonly deadlineMs: number;
  readonly audit: (
    event: ToolAuditEvent
  ) => Effect.Effect<void, ContractFailure>;
}

// The person deciding gets this long, independent of the model request deadline.
const APPROVAL_TTL_MS = 30 * 60 * 1000;
const DISPATCH_MEMO = "cerebro-dispatch";
const OUTCOME_MEMO = "cerebro-outcome";
// Bookkeeping after a call ends, such as the settled audit event, gets this
// long whatever the request deadline left.
const CLEANUP_MS = 30_000;
type RecordedOutcome =
  | { readonly state: "succeeded"; readonly output: string }
  | { readonly state: "failed"; readonly reason: string };
const toolResult = (outcome: RecordedOutcome) =>
  outcome.state === "succeeded"
    ? { output: [{ text: outcome.output, type: "text" as const }] }
    : {
        output: [{ text: outcome.reason, type: "text" as const }],
        isError: true,
      };
const failureReason = (failure: ContractFailure): string =>
  "reason" in failure ? failure.reason : `${failure.resource} was not found`;
const settledOutcome = (
  failure: ContractFailure,
  dispatched: boolean
): ToolCallOutcome => {
  if (failure._tag === "UnknownOutcome") {
    return "unknown";
  }
  return failure._tag === "Denied" && !dispatched ? "denied" : "failed";
};
const unknownResult = {
  output: [
    {
      text: "The tool was dispatched but its outcome is unknown. It will not be retried. Check the target system before another attempt.",
      type: "text" as const,
    },
  ],
  isError: true,
};

// Wakes on a decision or a revalidate hint instead of polling. Only a denial ends the wait;
// a transient failure while rechecking keeps the approval pending.
const awaitDecision = (
  approvals: ReturnType<typeof createApprovalStore>,
  approvalId: string,
  readDecision: Effect.Effect<BoundApproval | undefined, ContractFailure>,
  recheck: Effect.Effect<unknown, ContractFailure>,
  waiting: ReadOptions
) =>
  Effect.gen(function* waitForDecision() {
    for (;;) {
      const change = approvals.nextChange(approvalId);
      const approved = yield* readDecision;
      if (approved) {
        return approved;
      }
      if ((yield* waitForCaller(change, waiting)) === "revalidate") {
        yield* recheck.pipe(
          Effect.catchIf(
            (failure) => failure._tag !== "Denied",
            () => Effect.void
          )
        );
      }
    }
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
        const window = () => ({
          deadlineAt: Date.now() + configuration.deadlineMs,
          signal: context.abortSignal,
        });
        let options = window();
        let dispatched = false;
        let approvalId: string | undefined;
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
        let facts: ToolCallFacts = {
          actorPrincipalId: null,
          argumentDigest: null,
          connectorId: tool.connectorId,
          delegationId: null,
          effect: tool.effect,
          operationId,
          policyVersion: null,
          representedPrincipalId: null,
          toolId: tool.id,
          toolVersion: tool.version,
        };
        const scope = {
          agentId: configuration.agent.agentId,
          kind: "audit" as const,
          organizationId: configuration.address.organizationId,
          runId,
          sessionId: configuration.address.sessionId,
        };
        // Pi replays a tool call after a crash. The memo keeps the first event,
        // so a replay sends the same event and the sink stores it once.
        const record = (event: ToolAuditEvent, recordOptions: ReadOptions) =>
          waitForCaller(
            vendorEffect(recordOptions, () =>
              api.memo(`cerebro-audit:${event.name}`, event, context)
            ).pipe(
              Effect.tap(() => configuration.persist()),
              Effect.flatMap(configuration.audit)
            ),
            recordOptions
          );
        // Best effort. An interrupted call is not over: Pi replays it, and a
        // memo written now would freeze an outcome the replay has not reached.
        const settle = (outcome: ToolCallOutcome, reason: string | null) =>
          record(
            {
              ...scope,
              eventId: `${operationId}:tool.settled`,
              name: "tool.settled",
              occurredAt: Date.now(),
              payload: {
                ...facts,
                approvalId: approvalId ?? null,
                outcome,
                reason,
              },
            },
            { deadlineAt: Date.now() + CLEANUP_MS, signal: context.abortSignal }
          ).pipe(Effect.ignore);
        const program = Effect.gen(function* executeControlledTool() {
          const prepared = yield* waitForCaller(
            registered.prepare?.(args) ?? Effect.succeed(args),
            options
          );
          const executionContext = yield* configuration.ownerContext();
          const argumentDigest = yield* vendorEffect(options, () =>
            digestToolArguments(prepared)
          );
          facts = {
            ...facts,
            actorPrincipalId: executionContext.actor.id,
            argumentDigest,
            delegationId: executionContext.delegation?.id ?? null,
            representedPrincipalId: executionContext.represented?.id ?? null,
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
          facts = { ...facts, policyVersion: permit.policyVersion };
          yield* configuration.checkDependencies(
            executionContext,
            yield* configuration.dependencies(tool, prepared),
            options
          );
          const recorded = yield* vendorEffect(options, () =>
            api.memo<RecordedOutcome>(OUTCOME_MEMO, context)
          );
          if (recorded) {
            return recorded;
          }
          const interrupted = yield* vendorEffect(options, () =>
            api.memo<string>(DISPATCH_MEMO, context)
          );
          if (interrupted !== undefined && !registered.idempotent) {
            return yield* Effect.fail(
              new UnknownOutcome({
                operationId,
                reason: "The call was interrupted after dispatch.",
              })
            );
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
              expiresAt: Date.now() + APPROVAL_TTL_MS,
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
            const state = yield* vendorEffect(options, () =>
              configuration.metadata(
                () => configuration.approvals.read(retained.id).state
              )
            );
            yield* vendorEffect(options, () =>
              api.details(
                {
                  approvalId: retained.id,
                  state,
                },
                context
              )
            );
            const waiting = {
              deadlineAt: retained.expiresAt,
              signal: context.abortSignal,
            };
            const approved = yield* awaitDecision(
              configuration.approvals,
              retained.id,
              vendorEffect(waiting, () =>
                api.commit(
                  () => configuration.approvals.requireAllowed(retained.id),
                  context
                )
              ),
              Effect.suspend(() =>
                configuration.authority.require(request, window())
              ),
              waiting
            );
            options = window();
            permit = yield* configuration.authority.require(request, options);
            facts = { ...facts, policyVersion: permit.policyVersion };
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
          yield* configuration.checkDependencies(
            executionContext,
            yield* configuration.dependencies(tool, prepared),
            options
          );
          yield* record(
            {
              ...scope,
              eventId: `${operationId}:tool.dispatched`,
              name: "tool.dispatched",
              occurredAt: Date.now(),
              payload: {
                ...facts,
                actorPrincipalId: executionContext.actor.id,
                approvalId: approvalId ?? null,
                argumentDigest,
                policyVersion: permit.policyVersion,
              },
            },
            options
          ).pipe(
            Effect.mapError(
              () =>
                new Unavailable({
                  reason: "The tool call could not be audited.",
                })
            )
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
            { ...options, operationId, requestDigest: argumentDigest }
          );
          // A revocation during the call withholds a read's output. A write may
          // already have happened, so its outcome becomes unknown.
          yield* configuration.authority.require(request, window()).pipe(
            Effect.catch((error) =>
              Effect.fail(
                tool.effect === "write"
                  ? new UnknownOutcome({
                      operationId,
                      reason:
                        "Access changed while the connector call ran. Its outcome is unknown.",
                    })
                  : error
              )
            )
          );
          const succeeded: RecordedOutcome = {
            output: canonicalToolArguments(execution.output),
            state: "succeeded",
          };
          yield* vendorEffect(options, () =>
            api.memo<RecordedOutcome>(OUTCOME_MEMO, succeeded, context)
          ).pipe(Effect.andThen(configuration.persist()), Effect.ignore);
          return succeeded;
        });
        try {
          return await Effect.runPromise(
            program.pipe(
              Effect.tap((outcome) =>
                settle(
                  outcome.state,
                  outcome.state === "failed" ? outcome.reason : null
                )
              ),
              Effect.tapError((error) =>
                settle(settledOutcome(error, dispatched), failureReason(error))
              ),
              Effect.map(toolResult),
              Effect.catch((error) => {
                if (error._tag === "UnknownOutcome") {
                  return Effect.succeed(unknownResult);
                }
                if (!dispatched) {
                  return Effect.fail(error);
                }
                return vendorEffect(
                  { deadlineAt: Date.now() + CLEANUP_MS },
                  () =>
                    api.memo<RecordedOutcome>(
                      OUTCOME_MEMO,
                      {
                        reason: failureReason(error),
                        state: "failed",
                      },
                      context
                    )
                ).pipe(Effect.ignore, Effect.andThen(Effect.fail(error)));
              }),
              Effect.mapError((error) => new Error(failureReason(error)))
            ),
            { signal: context.abortSignal }
          );
        } finally {
          const pendingApprovalId = approvalId;
          if (pendingApprovalId) {
            await configuration.metadata(() =>
              configuration.approvals.cancel(pendingApprovalId)
            );
          }
        }
      },
      name: registered.definition.id,
      parameters: registered.parameters,
      replay: "safe" as const,
    }));
