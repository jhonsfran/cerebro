import type {
  AgentId,
  Digest,
  ExecutionContext,
  OperationId,
  OrganizationId,
  ReservationId,
} from "./identity.ts";
import type { EffectOptions, PortResult, ReadOptions } from "./port.ts";

export interface Resource {
  readonly organizationId: OrganizationId;
  readonly kind: "agent" | "tool" | "memory" | "artifact" | "audit" | "budget";
  readonly id: string;
}

export type Action =
  | "read"
  | "execute"
  | "write"
  | "approve"
  | "manage"
  | "export";

export type AuthorizationDecision =
  | { readonly decision: "allow"; readonly policyVersion: string }
  | {
      readonly decision: "deny";
      readonly reason: string;
      readonly policyVersion: string;
    };

export interface AuthorizationPolicy {
  readonly evaluate: (
    context: ExecutionContext,
    action: Action,
    resource: Resource,
    options: ReadOptions
  ) => Promise<PortResult<AuthorizationDecision>>;
}

export interface EntitlementRequest {
  readonly organizationId: OrganizationId;
  readonly agentId: AgentId;
  readonly capability: string;
  readonly model?: string;
}

export type EntitlementDecision =
  | { readonly decision: "allow"; readonly policyVersion: string }
  | {
      readonly decision: "deny";
      readonly reason: string;
      readonly policyVersion: string;
    };

export interface EntitlementPolicy {
  readonly check: (
    request: EntitlementRequest,
    options: ReadOptions
  ) => Promise<PortResult<EntitlementDecision>>;
}

export interface BudgetAmount {
  readonly units: number;
  readonly unit: string;
}

export interface BudgetReservation {
  readonly id: ReservationId;
  readonly organizationId: OrganizationId;
  readonly operationId: OperationId;
  readonly maximum: BudgetAmount;
  readonly state: "reserved" | "settled" | "released";
}

export interface BudgetAuthority {
  readonly reserve: (
    organizationId: OrganizationId,
    maximum: BudgetAmount,
    options: EffectOptions
  ) => Promise<PortResult<BudgetReservation>>;
  readonly inspect: (
    organizationId: OrganizationId,
    options: ReadOptions
  ) => Promise<PortResult<BudgetAmount>>;
  readonly settle: (
    reservationId: ReservationId,
    incurred: BudgetAmount,
    options: EffectOptions
  ) => Promise<PortResult<BudgetReservation>>;
  readonly release: (
    reservationId: ReservationId,
    options: EffectOptions
  ) => Promise<PortResult<BudgetReservation>>;
}

export type DecisionChoice = "run" | "clarify" | "defer";

export interface DecisionRequest {
  readonly organizationId: OrganizationId;
  readonly inputDigest: Digest;
  readonly eventSummary: string;
  readonly allowedChoices: readonly DecisionChoice[];
  readonly modelVersion: string;
}

export interface DecisionProposal {
  readonly choice: DecisionChoice;
  readonly inputDigest: Digest;
  readonly modelVersion: string;
  readonly usage: BudgetAmount;
}

export interface DecisionMaker {
  readonly propose: (
    request: DecisionRequest,
    options: EffectOptions
  ) => Promise<PortResult<DecisionProposal>>;
}
