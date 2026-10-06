/* oxlint-disable no-redeclare -- Effect service tags and schemas share their TypeScript type name. */
import { Context } from "effect";
import type { Effect } from "effect";

import type { ContractFailure } from "./failures.ts";
import type { OperationId, OrganizationId } from "./identity.ts";
import type { EffectOptions, ReadOptions } from "./port.ts";

export interface MeterKey {
  readonly organizationId: OrganizationId;
  readonly operationId: OperationId;
  readonly idempotencyKey: string;
}
export interface MeterReservation {
  readonly key: MeterKey;
  readonly providerHandle: string;
  readonly state: "reserved" | "settled" | "released" | "unknown";
}
export interface UsageEvidence {
  readonly provider: string;
  readonly requestId: string;
  readonly observedAt: number;
  readonly raw: unknown;
}
export interface ExternalMeter {
  readonly reserve: (
    key: MeterKey,
    evidence: readonly UsageEvidence[],
    options: EffectOptions
  ) => Effect.Effect<MeterReservation, ContractFailure>;
  readonly settle: (
    reservation: MeterReservation,
    evidence: readonly UsageEvidence[],
    options: EffectOptions
  ) => Effect.Effect<MeterReservation, ContractFailure>;
  readonly release: (
    reservation: MeterReservation,
    options: EffectOptions
  ) => Effect.Effect<MeterReservation, ContractFailure>;
  readonly lookup: (
    key: MeterKey,
    options: ReadOptions
  ) => Effect.Effect<MeterReservation, ContractFailure>;
}
// Deliberately no Layer: spend control is not active through this port in slice 1.
export const ExternalMeter = Context.Service<ExternalMeter>(
  "@cerebro/ExternalMeter"
);
