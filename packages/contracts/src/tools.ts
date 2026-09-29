import { isExecutionContextActiveAt } from "./identity.ts";
import type {
  AgentId,
  Digest,
  ExecutionContext,
  OperationId,
  OrganizationId,
  PrincipalId,
  ToolId,
} from "./identity.ts";
import type { EffectOptions, PortResult, ReadOptions } from "./port.ts";

export interface ToolDefinition {
  readonly id: ToolId;
  readonly version: string;
  readonly effect: "read" | "write";
  readonly connectorId: string;
}

export interface ToolCall {
  readonly organizationId: OrganizationId;
  readonly agentId: AgentId;
  readonly tool: ToolDefinition;
  readonly arguments: unknown;
  readonly context: ExecutionContext;
}

export interface ToolCapability {
  readonly organizationId: OrganizationId;
  readonly toolId: ToolId;
  readonly toolVersion: string;
  readonly connectorId: string;
  readonly effect: "read" | "write";
  readonly agentId: AgentId;
  readonly principalId: PrincipalId;
  readonly operationId: OperationId;
  readonly argumentDigest: Digest;
  readonly expiresAt: number;
}

export const toolCapabilityMatches = (
  capability: ToolCapability,
  call: ToolCall,
  options: EffectOptions,
  now: number
): boolean =>
  isExecutionContextActiveAt(call.context, call.organizationId, now) &&
  capability.organizationId === call.organizationId &&
  capability.toolId === call.tool.id &&
  capability.toolVersion === call.tool.version &&
  capability.connectorId === call.tool.connectorId &&
  capability.effect === call.tool.effect &&
  capability.agentId === call.agentId &&
  capability.principalId ===
    (call.context.represented?.id ?? call.context.actor.id) &&
  capability.operationId === options.operationId &&
  capability.argumentDigest === options.requestDigest &&
  capability.expiresAt > now;

export type ToolInvocation = ToolCall & {
  readonly operationId: OperationId;
  readonly argumentDigest: Digest;
} & (
    | { readonly state: "requested" | "waiting-for-approval" | "running" }
    | {
        readonly state: "succeeded";
        readonly result: unknown;
        readonly providerReceipt?: string;
      }
    | { readonly state: "failed" | "cancelled"; readonly reason: string }
    | { readonly state: "unknown-outcome"; readonly providerReceipt?: string }
  );

export interface Approval {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly operationId: OperationId;
  readonly toolId: ToolId;
  readonly toolVersion: string;
  readonly argumentDigest: Digest;
  readonly principalId: PrincipalId;
  readonly policyVersion: string;
  readonly approverId: PrincipalId;
  readonly expiresAt: number;
}

// The caller must recheck current grants before it uses a matching approval.
export const approvalMatches = (
  approval: Approval,
  invocation: ToolInvocation,
  policyVersion: string,
  now: number
): boolean =>
  isExecutionContextActiveAt(
    invocation.context,
    invocation.organizationId,
    now
  ) &&
  approval.organizationId === invocation.organizationId &&
  approval.operationId === invocation.operationId &&
  approval.toolId === invocation.tool.id &&
  approval.toolVersion === invocation.tool.version &&
  approval.argumentDigest === invocation.argumentDigest &&
  approval.principalId ===
    (invocation.context.represented?.id ?? invocation.context.actor.id) &&
  approval.policyVersion === policyVersion &&
  approval.expiresAt > now;

export interface ToolExecution {
  readonly output: unknown;
  readonly providerReceipt?: string;
}

export interface ToolExecutor {
  readonly execute: (
    call: ToolCall,
    capability: ToolCapability,
    options: EffectOptions
  ) => Promise<PortResult<ToolExecution>>;
  // Reconciliation may inspect a provider receipt. It must not execute the effect again.
  readonly reconcile: (
    operationId: OperationId,
    context: ExecutionContext,
    options: ReadOptions
  ) => Promise<PortResult<ToolExecution>>;
}
