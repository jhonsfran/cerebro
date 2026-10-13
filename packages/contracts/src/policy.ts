import type { AgentId, ExecutionContext, OrganizationId } from "./identity.ts";
import type { PortResult, ReadOptions } from "./port.ts";
import type { RegisteredTool } from "./tools.ts";

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

export type EntitlementRequest = {
  readonly organizationId: OrganizationId;
  readonly agentId: AgentId;
} & (
  | { readonly kind: "model"; readonly model: string }
  | { readonly kind: "tool"; readonly tool: RegisteredTool }
);

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
