import { canonicalToolArguments } from "@cerebro/contracts/tools";
import { eq } from "drizzle-orm";

import type { Database } from "../index";
import { auditEvent } from "../schema/audit";

export interface AuditProjection {
  readonly eventId: string;
  readonly organizationId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly kind: "audit";
  readonly name: string;
  readonly occurredAt: number;
  readonly payload: unknown;
}

export class AuditProjectionConflictError extends Error {
  constructor() {
    super("Audit event ID is bound to a different payload.");
    this.name = "AuditProjectionConflictError";
  }
}

export const projectAuditEvent = async (
  database: Database,
  event: AuditProjection
): Promise<void> => {
  const inserted = await database
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
    .onConflictDoNothing({ target: auditEvent.eventId })
    .returning({ eventId: auditEvent.eventId });
  if (inserted.length > 0) {
    return;
  }
  const [prior] = await database
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.eventId, event.eventId));
  if (
    !prior ||
    canonicalToolArguments({
      ...prior,
      occurredAt: prior.occurredAt.getTime(),
    }) !== canonicalToolArguments(event)
  ) {
    throw new AuditProjectionConflictError();
  }
};
