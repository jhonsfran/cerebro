import type { SessionEvent } from "../../contracts/src/events.ts";
import type {
  AgentId,
  ExecutionContext,
  OrganizationId,
} from "../../contracts/src/identity.ts";
import type { OperationJournal } from "../../contracts/src/operation-journal.ts";
import type {
  DecisionMaker,
  DecisionProposal,
  DecisionRequest,
  Resource,
} from "../../contracts/src/policy.ts";
import { preflightEffect } from "../../contracts/src/port.ts";
import type { EffectOptions, PortResult } from "../../contracts/src/port.ts";
import { immutable } from "../../db/src/repositories/usage.ts";
import type { PaidWork } from "./authorization-gate.ts";
import type { BoundedDecisionProvider } from "./jev-adapter.ts";

export const createDecisionRouter = (dependencies: {
  readonly context: ExecutionContext;
  readonly agentId: AgentId;
  readonly address: unknown;
  readonly paidWork: PaidWork<DecisionProposal>;
  readonly provider: BoundedDecisionProvider;
  readonly hardPolicy: (
    proposal: DecisionProposal,
    options: EffectOptions
  ) => Promise<PortResult<void>>;
}): DecisionMaker => ({
  async propose(suppliedRequest, suppliedOptions) {
    const request = immutable(suppliedRequest);
    const options = Object.freeze({ ...suppliedOptions });
    const ready = preflightEffect(options, Date.now());
    if (ready.status !== "ok") {
      return ready;
    }
    if (
      request.organizationId !== dependencies.context.actor.organizationId ||
      request.allowedChoices.length === 0 ||
      request.modelVersion !== dependencies.provider.modelVersion
    ) {
      return {
        reason: "Decision company, choices, or pinned model do not match.",
        status: "invalid-input",
      };
    }
    const resource: Resource = {
      id: dependencies.agentId,
      kind: "agent",
      organizationId: request.organizationId,
    };
    const paidRequest = {
      action: "execute" as const,
      context: dependencies.context,
      entitlement: {
        agentId: dependencies.agentId,
        capability: "decision",
        model: request.modelVersion,
        organizationId: request.organizationId,
      },
      input: {
        address: dependencies.address,
        context: dependencies.context,
        request,
      },
      maximum: dependencies.provider.maximum,
      resource,
    };
    const result = await dependencies.paidWork.run(
      paidRequest,
      options,
      async () => await dependencies.provider.propose(request, options)
    );
    if (result.status !== "ok") {
      return result;
    }
    const allowed = await dependencies.hardPolicy(result.value, options);
    return allowed.status === "ok" ? result : allowed;
  },
});
export type DecisionTrigger = Extract<
  SessionEvent,
  { readonly type: "user.message" | "scheduled.run" }
>;
export type ControlEvent =
  | Exclude<SessionEvent, DecisionTrigger>
  | {
      readonly type: "identity.revoked";
      readonly payload: { readonly principalId: string };
    }
  | {
      readonly type: "maintenance";
      readonly payload: { readonly task: string };
    };
export type PolicyEvent =
  | { readonly event: DecisionTrigger; readonly request: DecisionRequest }
  | { readonly event: ControlEvent; readonly request?: never };
export type PolicyEventOutcome =
  | { readonly kind: "decision"; readonly proposal: DecisionProposal }
  | { readonly kind: "control"; readonly value: unknown };
const controlResult = (
  result: PortResult<unknown>
): PortResult<PolicyEventOutcome> =>
  result.status === "ok"
    ? { status: "ok", value: { kind: "control", value: result.value } }
    : result;
export const createPolicyEventDispatcher = (dependencies: {
  readonly organizationId: OrganizationId;
  readonly context: ExecutionContext;
  readonly decisions: DecisionMaker;
  readonly controls: OperationJournal<unknown>;
  readonly handleControl: (
    event: ControlEvent,
    options: EffectOptions
  ) => Promise<PortResult<unknown>>;
}) => ({
  async dispatch(
    suppliedInput: PolicyEvent,
    suppliedOptions: EffectOptions
  ): Promise<PortResult<PolicyEventOutcome>> {
    const input = immutable(suppliedInput);
    const options = Object.freeze({ ...suppliedOptions });
    const ready = preflightEffect(options, Date.now());
    if (ready.status !== "ok") {
      return ready;
    }
    switch (input.event.type) {
      case "user.message":
      case "scheduled.run": {
        if (!input.request) {
          return {
            reason: "A decision event requires its bounded request.",
            status: "invalid-input",
          };
        }
        const proposal = await dependencies.decisions.propose(
          input.request,
          options
        );
        return proposal.status === "ok"
          ? {
              status: "ok",
              value: { kind: "decision", proposal: proposal.value },
            }
          : proposal;
      }
      case "approval.granted":
      case "approval.rejected":
      case "run.cancelled":
      case "identity.revoked":
      case "maintenance": {
        const claimed = await dependencies.controls.claim(
          {
            operationId: options.operationId,
            organizationId: dependencies.organizationId,
            request: { context: dependencies.context, event: input.event },
            requestDigest: options.requestDigest,
          },
          options
        );
        if (claimed.status !== "ok") {
          return claimed;
        }
        if (claimed.value.state === "pending") {
          return {
            operationId: options.operationId,
            reason: "Control event already has a durable owner.",
            status: "unknown-outcome",
          };
        }
        if (claimed.value.state === "completed") {
          const { result } = claimed.value;
          return controlResult(result);
        }
        const token = claimed.value.claimToken;
        const dispatched = await dependencies.controls.dispatch(
          token,
          { eventType: input.event.type },
          options
        );
        if (dispatched.status !== "ok") {
          return dispatched;
        }
        const maintenance = (): EffectOptions => ({
          ...options,
          deadlineAt: Date.now() + 15_000,
          signal: undefined,
        });
        let result: PortResult<unknown>;
        try {
          result = await dependencies.handleControl(input.event, options);
        } catch {
          const saved = await dependencies.controls.unknown(
            token,
            "Control handler failed after dispatch.",
            maintenance()
          );
          return saved.status === "ok"
            ? {
                operationId: options.operationId,
                reason: "Control handler requires reconciliation.",
                status: "unknown-outcome",
              }
            : saved;
        }
        if (result.status === "unknown-outcome") {
          await dependencies.controls.unknown(
            token,
            result.reason,
            maintenance()
          );
          return result;
        }
        const saved = await dependencies.controls.complete(
          token,
          result,
          maintenance()
        );
        if (saved.status !== "ok") {
          return saved;
        }
        return controlResult(result);
      }
      default: {
        return {
          reason: "Unknown policy event type.",
          status: "invalid-input",
        };
      }
    }
  },
});
