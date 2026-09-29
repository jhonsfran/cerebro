import type { ToolExecution } from "@cerebro/contracts/tools";

import type { SessionLedger, StoredInvocation } from "./ledger.ts";

export interface InvocationEffect {
  readonly authorize: (invocation: StoredInvocation) => Promise<boolean>;
  readonly execute: (invocation: StoredInvocation) => Promise<ToolExecution>;
}

export const recoverInterruptedInvocation = async (
  ledger: SessionLedger,
  invocation: StoredInvocation,
  effect: InvocationEffect
): Promise<void> => {
  if (invocation.state !== "running") {
    return;
  }
  if (!invocation.idempotent) {
    ledger.markUnknownOutcome(invocation.operationId);
    return;
  }
  if (!(await effect.authorize(invocation))) {
    ledger.markUnknownOutcome(invocation.operationId);
    return;
  }
  try {
    const result = await effect.execute(invocation);
    ledger.finishInvocation(invocation.operationId, result);
  } catch {
    // The scheduled callback retries the same operation ID.
  }
};

export const recoverInterruptedInvocations = async (
  ledger: SessionLedger,
  effect: InvocationEffect
): Promise<void> => {
  for (const invocation of ledger.invocations()) {
    // Recovery order follows the durable invocation order.
    // oxlint-disable-next-line no-await-in-loop
    await recoverInterruptedInvocation(ledger, invocation, effect);
  }
};
