import type {
  AgentId,
  ExecutionContext,
  OperationId,
  OrganizationId,
  ReservationId,
} from "./identity.ts";
import type { PortResult, ReadOptions } from "./port.ts";

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
