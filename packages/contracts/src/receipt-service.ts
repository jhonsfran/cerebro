/* oxlint-disable no-redeclare -- Effect service tags and schemas share their TypeScript type name. */
import { Context } from "effect";
import type { Effect } from "effect";

import type { ContractFailure } from "./failures.ts";
import type {
  ExecutionContext,
  OperationId,
  OrganizationId,
} from "./identity.ts";
import type { EffectOptions, ReadOptions } from "./port.ts";
import type { BoundApproval, BoundInvocation } from "./tool-service.ts";
import type { ToolExecution } from "./tools.ts";

export interface ReceiptKey {
  readonly organizationId: OrganizationId;
  readonly operationId: OperationId;
}
export interface EffectIntent {
  readonly invocation: BoundInvocation;
  readonly policyVersion: string;
}
export type ReceiptOutcome =
  | { readonly state: "succeeded"; readonly execution: ToolExecution }
  | {
      readonly state: "failed";
      readonly reason: string;
      readonly providerReceipt?: string;
    };
export type ToolReceipt = {
  readonly key: ReceiptKey;
  readonly intent: EffectIntent;
  readonly revision: number;
} & (
  | { readonly state: "claimed" }
  | { readonly state: "dispatched"; readonly dispatchedAt: number }
  | {
      readonly state: "outcome" | "completed";
      readonly outcome: ReceiptOutcome;
    }
  | {
      readonly state: "unknown";
      readonly reason: string;
      readonly providerReceipt?: string;
    }
);
export interface ReceiptClaim {
  readonly receipt: ToolReceipt;
  readonly replayed: boolean;
}
export interface DispatchClaim {
  readonly receipt: ToolReceipt;
  readonly dispatch: boolean;
}
export interface ToolReceiptStore {
  readonly claim: (
    intent: EffectIntent,
    options: EffectOptions
  ) => Effect.Effect<ReceiptClaim, ContractFailure>;
  readonly read: (
    key: ReceiptKey,
    context: ExecutionContext,
    options: ReadOptions
  ) => Effect.Effect<ToolReceipt, ContractFailure>;
  readonly dispatch: (
    key: ReceiptKey,
    expectedRevision: number,
    approval: BoundApproval | undefined,
    options: EffectOptions
  ) => Effect.Effect<DispatchClaim, ContractFailure>;
  readonly recordOutcome: (
    key: ReceiptKey,
    outcome: ReceiptOutcome,
    options: EffectOptions
  ) => Effect.Effect<ToolReceipt, ContractFailure>;
  readonly complete: (
    key: ReceiptKey,
    options: EffectOptions
  ) => Effect.Effect<ToolReceipt, ContractFailure>;
  readonly unknown: (
    key: ReceiptKey,
    reason: string,
    providerReceipt: string | undefined,
    options: EffectOptions
  ) => Effect.Effect<ToolReceipt, ContractFailure>;
}
export const ToolReceiptStore = Context.GenericTag<ToolReceiptStore>(
  "@cerebro/ToolReceiptStore"
);
