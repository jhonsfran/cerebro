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

export const classifyEventDelivery = (
  prior:
    | Pick<EventEnvelope, "eventId" | "payloadDigest" | keyof EventAddress>
    | undefined,
  next: EventEnvelope
): "new" | "duplicate" | "conflict" => {
  if (!prior || prior.eventId !== next.eventId) {
    return "new";
  }
  return prior.payloadDigest === next.payloadDigest &&
    prior.organizationId === next.organizationId &&
    prior.agentId === next.agentId &&
    prior.conversationId === next.conversationId &&
    prior.sessionId === next.sessionId
    ? "duplicate"
    : "conflict";
};
