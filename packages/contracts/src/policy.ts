import type { AgentId, ExecutionContext, OrganizationId } from "./identity.ts";
import type { PortResult, ReadOptions } from "./port.ts";

export interface Resource {
  readonly organizationId: OrganizationId;
  readonly kind: "agent" | "tool" | "memory" | "artifact" | "audit";
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
