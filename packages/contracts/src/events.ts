import { sameExecutionContext } from "./identity.ts";
import type {
  AgentId,
  ConversationId,
  Digest,
  EventId,
  ExecutionContext,
  OperationId,
  OrganizationId,
  RunId,
  SessionId,
} from "./identity.ts";

export interface EventAddress {
  readonly organizationId: OrganizationId;
  readonly agentId: AgentId;
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
}

export type SessionEvent =
  | {
      readonly type: "user.message";
      readonly payload: { readonly text: string };
    }
  | {
      readonly type: "scheduled.run";
      readonly payload: { readonly task: string };
    }
  | {
      readonly type: "approval.granted";
      readonly payload: {
        readonly approvalId: string;
        readonly operationId: OperationId;
      };
    }
  | {
      readonly type: "approval.rejected";
      readonly payload: {
        readonly approvalId: string;
        readonly operationId: OperationId;
      };
    }
  | {
      readonly type: "run.cancelled";
      readonly payload: { readonly runId: RunId };
    };

export type EventEnvelope = EventAddress & {
  readonly eventId: EventId;
  readonly schemaVersion: 1;
  readonly occurredAt: number;
  readonly payloadDigest: Digest;
  readonly context: ExecutionContext;
  readonly event: SessionEvent;
};

const sameSessionEvent = (
  first: SessionEvent,
  second: SessionEvent
): boolean => {
  switch (first.type) {
    case "user.message": {
      return (
        second.type === "user.message" &&
        first.payload.text === second.payload.text
      );
    }
    case "scheduled.run": {
      return (
        second.type === "scheduled.run" &&
        first.payload.task === second.payload.task
      );
    }
    case "approval.granted":
    case "approval.rejected": {
      return (
        second.type === first.type &&
        first.payload.approvalId === second.payload.approvalId &&
        first.payload.operationId === second.payload.operationId
      );
    }
    case "run.cancelled": {
      return (
        second.type === "run.cancelled" &&
        first.payload.runId === second.payload.runId
      );
    }
    default: {
      return false;
    }
  }
};

export const classifyEventDelivery = (
  prior: EventEnvelope | undefined,
  next: EventEnvelope
): "new" | "duplicate" | "conflict" => {
  if (!prior || prior.eventId !== next.eventId) {
    return "new";
  }
  return prior.payloadDigest === next.payloadDigest &&
    prior.organizationId === next.organizationId &&
    prior.agentId === next.agentId &&
    prior.conversationId === next.conversationId &&
    prior.sessionId === next.sessionId &&
    prior.schemaVersion === next.schemaVersion &&
    prior.occurredAt === next.occurredAt &&
    sameExecutionContext(prior.context, next.context) &&
    sameSessionEvent(prior.event, next.event)
    ? "duplicate"
    : "conflict";
};
