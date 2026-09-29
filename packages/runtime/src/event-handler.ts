import type { EventAddress, EventEnvelope } from "@cerebro/contracts/events";
import { isExecutionContextActiveAt } from "@cerebro/contracts/identity";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type {
  AuthorizationPolicy,
  EntitlementPolicy,
} from "@cerebro/contracts/policy";
import type { PortResult, ReadOptions } from "@cerebro/contracts/port";

export const sessionName = (address: EventAddress): string =>
  JSON.stringify([
    address.organizationId,
    address.agentId,
    address.conversationId,
  ]);

export const sameAddress = (
  first: EventAddress,
  second: EventAddress
): boolean =>
  first.organizationId === second.organizationId &&
  first.agentId === second.agentId &&
  first.conversationId === second.conversationId &&
  first.sessionId === second.sessionId;

export const validateEvent = (
  event: EventEnvelope,
  now: number
): PortResult<void> => {
  if (
    !event.context ||
    typeof event.context !== "object" ||
    !event.context.actor ||
    typeof event.context.actor !== "object"
  ) {
    return {
      code: "unauthorized",
      reason: "Event context is missing",
      status: "denied",
    };
  }
  if (event.context.delegation && !event.context.represented) {
    return {
      code: "unauthorized",
      reason: "Delegation context is incomplete",
      status: "denied",
    };
  }
  if (
    event.schemaVersion !== 1 ||
    !Number.isFinite(event.occurredAt) ||
    !isExecutionContextActiveAt(event.context, event.organizationId, now)
  ) {
    return {
      code: "unauthorized",
      reason: "Invalid event context",
      status: "denied",
    };
  }
  if (
    event.event.type !== "user.message" &&
    event.event.type !== "scheduled.run"
  ) {
    return { reason: "Event does not start a run", status: "invalid-input" };
  }
  if (
    !event.payloadDigest ||
    !event.eventId ||
    !event.sessionId ||
    !event.conversationId
  ) {
    return { reason: "Event identity is incomplete", status: "invalid-input" };
  }
  return { status: "ok", value: undefined };
};

export const authorizeSession = async (
  policy: AuthorizationPolicy,
  entitlement: EntitlementPolicy,
  address: EventAddress,
  context: ExecutionContext,
  action: "read" | "execute" | "approve",
  options: ReadOptions
): Promise<PortResult<void>> => {
  if (
    !isExecutionContextActiveAt(context, address.organizationId, Date.now())
  ) {
    return {
      code: "unauthorized",
      reason: "Principal context is inactive",
      status: "denied",
    };
  }
  const authorization = await policy.evaluate(
    context,
    action,
    {
      id: address.agentId,
      kind: "agent",
      organizationId: address.organizationId,
    },
    options
  );
  if (authorization.status !== "ok") {
    return authorization;
  }
  if (authorization.value.decision !== "allow") {
    return {
      code: "unauthorized",
      reason: authorization.value.reason,
      status: "denied",
    };
  }
  if (action === "execute") {
    const decision = await entitlement.check(
      {
        agentId: address.agentId,
        capability: "session.execute",
        organizationId: address.organizationId,
      },
      options
    );
    if (decision.status !== "ok") {
      return decision;
    }
    if (decision.value.decision !== "allow") {
      return {
        code: "entitlement",
        reason: decision.value.reason,
        status: "denied",
      };
    }
  }
  return { status: "ok", value: undefined };
};
