import type { ToolExecution } from "@cerebro/contracts/tools";

import type { SessionLedger, StoredInvocation } from "./ledger.ts";

export interface InvocationEffect {
  readonly authorize: (invocation: StoredInvocation) => Promise<boolean>;
  readonly execute: (invocation: StoredInvocation) => Promise<ToolExecution>;
}

export const recoverInterruptedInvocations = async (
  ledger: SessionLedger,
  effect: InvocationEffect
): Promise<void> => {
  for (const invocation of ledger.invocations()) {
    if (invocation.state !== "running") {
      continue;
    }
    // Recovery order follows the durable invocation order.
    // oxlint-disable-next-line no-await-in-loop
    if (!(await effect.authorize(invocation))) {
      ledger.updateInvocation(invocation.operationId, (current) => ({
        ...current,
        state: "cancelled",
      }));
      ledger.updateRun(invocation.runId, (run) => ({
        ...run,
        endedAt: Date.now(),
        state: "failed",
      }));
      continue;
    }
    if (!invocation.idempotent) {
      ledger.updateInvocation(invocation.operationId, (current) => ({
        ...current,
        state: "unknown-outcome",
      }));
      ledger.updateRun(invocation.runId, (run) => ({
        ...run,
        state: "unknown-outcome",
      }));
      continue;
    }
    try {
      // Do not run effects concurrently during recovery.
      // oxlint-disable-next-line no-await-in-loop
      const result = await effect.execute(invocation);
      ledger.updateInvocation(invocation.operationId, (current) => ({
        ...current,
        providerReceipt: result.providerReceipt,
        result: structuredClone(result),
        state: "succeeded",
      }));
    } catch {
      // The scheduled callback retries the same operation ID.
    }
  }
};
