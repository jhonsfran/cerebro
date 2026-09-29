import type { OutboxEvent, SessionLedger } from "./ledger.ts";

export interface OutboxSink {
  readonly project: (event: OutboxEvent) => Promise<void>;
}

export const drainOutbox = async (
  ledger: SessionLedger,
  sink: OutboxSink
): Promise<number> => {
  let delivered = 0;
  for (const event of ledger.pendingOutbox()) {
    // Acknowledge one projection before sending the next event.
    // oxlint-disable-next-line no-await-in-loop
    await sink.project(structuredClone(event));
    ledger.acknowledgeOutbox(event.eventId);
    delivered += 1;
  }
  return delivered;
};
