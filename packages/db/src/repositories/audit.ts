import type { Database } from "../index";
import { auditEvent } from "../schema/audit";

export interface AuditProjection {
  readonly eventId: string;
  readonly organizationId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly kind: "audit" | "usage";
  readonly name: string;
  readonly occurredAt: number;
  readonly payload: unknown;
}

// The caller owns the request-scoped database connection. A duplicate outbox
// delivery leaves the first projection unchanged.
export const projectAuditEvent = async (
  database: Database,
  event: AuditProjection
): Promise<void> => {
  await database
    .insert(auditEvent)
    .values({
      agentId: event.agentId,
      eventId: event.eventId,
      kind: event.kind,
      name: event.name,
      occurredAt: new Date(event.occurredAt),
      organizationId: event.organizationId,
      payload: structuredClone(event.payload),
      runId: event.runId,
      sessionId: event.sessionId,
    })
    .onConflictDoNothing({ target: auditEvent.eventId });
};
