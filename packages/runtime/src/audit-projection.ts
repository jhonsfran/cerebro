import type { EventAddress } from "@cerebro/contracts/events";
import { InvalidInput } from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { DomainUpdate } from "@cerebro/contracts/session-service";
import { Effect } from "effect";

import type { ProjectionRecord } from "./celld-session-store.ts";
import { updateRunId } from "./pi-projection.ts";

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

const payload = (update: DomainUpdate): unknown => {
  switch (update.type) {
    case "run": {
      return { run: update.run };
    }
    case "execution": {
      return { execution: update.execution };
    }
    case "user-message": {
      const { text: _text, ...message } = update.message;
      return { message };
    }
    case "canonical-output": {
      const { text: _text, citations, ...output } = update.output;
      return {
        output: {
          ...output,
          citations: citations.map(({ sourceId, sourceVersion }) => ({
            sourceId,
            sourceVersion,
          })),
        },
      };
    }
    case "tool": {
      const {
        arguments: _arguments,
        output: _output,
        type: _type,
        ...tool
      } = update;
      return { tool };
    }
    case "approval": {
      const { type: _type, ...approval } = update;
      return { approval };
    }
    case "citation":
    case "provisional-text": {
      throw new InvalidInput({
        reason: "Ephemeral text is not an audit event",
      });
    }
    default: {
      throw new InvalidInput({ reason: "Invalid audit projection" });
    }
  }
};

export const auditProjection = (
  address: EventAddress,
  record: ProjectionRecord
): AuditProjection => {
  if (!Number.isFinite(record.occurredAt)) {
    throw new InvalidInput({
      reason: "Audit occurrence time is not persisted",
    });
  }
  return {
    agentId: address.agentId,
    eventId: `pi-audit:${record.id}`,
    kind: "audit",
    name: record.update.type,
    occurredAt: record.occurredAt,
    organizationId: address.organizationId,
    payload: payload(record.update),
    runId: updateRunId(record.update),
    sessionId: address.sessionId,
  };
};

export const drainAuditProjection = (
  address: EventAddress,
  store: {
    readonly outbox: () => readonly ProjectionRecord[];
    readonly acknowledgeOutbox: (
      id: string
    ) => Effect.Effect<void, ContractFailure>;
  },
  project: (event: AuditProjection) => Effect.Effect<void, ContractFailure>,
  maximumEvents = Number.POSITIVE_INFINITY
) =>
  Effect.gen(function* deliverAuditEvents() {
    for (let delivered = 0; delivered < maximumEvents; delivered += 1) {
      const [record] = store.outbox();
      if (!record) {
        return;
      }
      yield* project(auditProjection(address, record));
      yield* store.acknowledgeOutbox(record.id);
    }
  });
