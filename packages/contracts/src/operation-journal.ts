import type { OperationId, OrganizationId, Digest } from "./identity.ts";
import type { BudgetAmount } from "./policy.ts";
import type { EffectOptions, PortResult, ReadOptions } from "./port.ts";
import type { Approval, ToolExecution } from "./tools.ts";

export interface OperationIntent {
  readonly organizationId: OrganizationId;
  readonly operationId: OperationId;
  readonly requestDigest: Digest;
  readonly request: unknown;
}

export type OperationRecord<Value> = {
  readonly intent: OperationIntent;
  readonly claimToken: string;
} & (
  | { readonly state: "claimed" }
  | {
      readonly state: "reserve-intent";
      readonly metadata: Readonly<Record<string, unknown>>;
    }
  | {
      readonly state: "release-intent";
      readonly metadata: Readonly<Record<string, unknown>>;
      readonly result: PortResult<Value>;
    }
  | {
      readonly state: "dispatched";
      readonly metadata: Readonly<Record<string, unknown>>;
    }
  | {
      readonly state: "unknown-outcome";
      readonly metadata: Readonly<Record<string, unknown>>;
      readonly reason: string;
    }
  | {
      readonly state: "outcome-recorded";
      readonly metadata: Readonly<Record<string, unknown>>;
      readonly result: PortResult<Value>;
      readonly incurred: BudgetAmount;
    }
  | { readonly state: "completed"; readonly result: PortResult<Value> }
);

export type OperationClaim<Value> =
  | { readonly state: "claimed"; readonly claimToken: string }
  | {
      readonly state: "pending";
      readonly record: Exclude<
        OperationRecord<Value>,
        { readonly state: "completed" }
      >;
    }
  | { readonly state: "completed"; readonly result: PortResult<Value> };

/** Runtime storage must commit each transition atomically and return detached snapshots. */
export interface OperationJournal<Value> {
  /** Bind organization, operation ID, digest, and full JSON request before external work. */
  readonly claim: (
    intent: OperationIntent,
    options: EffectOptions
  ) => Promise<PortResult<OperationClaim<Value>>>;
  readonly read: (
    organizationId: OrganizationId,
    operationId: OperationId,
    options: ReadOptions
  ) => Promise<PortResult<OperationRecord<Value>>>;
  /** Move claimed to reserve-intent; repeated identical metadata is idempotent. */
  readonly recordReservationIntent: (
    claimToken: string,
    metadata: Readonly<Record<string, unknown>>,
    options: EffectOptions
  ) => Promise<PortResult<void>>;
  /** Compete with dispatch from reserve-intent; replay can only reconcile the saved release. */
  readonly recordReleaseIntent: (
    claimToken: string,
    metadata: Readonly<Record<string, unknown>>,
    result: PortResult<Value>,
    options: EffectOptions
  ) => Promise<PortResult<void>>;
  /** Only one claimed or reserve-intent caller succeeds; repeated dispatch must conflict. */
  readonly dispatch: (
    claimToken: string,
    metadata: Readonly<Record<string, unknown>>,
    options: EffectOptions
  ) => Promise<PortResult<void>>;
  /** Save known result and usage before accounting; the receipt must remain immutable. */
  readonly recordOutcome: (
    claimToken: string,
    result: PortResult<Value>,
    incurred: BudgetAmount,
    options: EffectOptions
  ) => Promise<PortResult<void>>;
  readonly complete: (
    claimToken: string,
    result: PortResult<Value>,
    options: EffectOptions
  ) => Promise<PortResult<void>>;
  /** Preserve dispatched intent without permitting redispatch or discarding a known receipt. */
  readonly unknown: (
    claimToken: string,
    reason: string,
    options: EffectOptions
  ) => Promise<PortResult<void>>;
}

export interface ToolOperationJournal extends OperationJournal<ToolExecution> {
  readonly approval: (
    organizationId: OrganizationId,
    operationId: OperationId,
    options: ReadOptions
  ) => Promise<PortResult<Approval>>;
}
