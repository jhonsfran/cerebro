/* oxlint-disable typescript/consistent-type-definitions -- Pi memos take JSON values, and only type aliases carry the implicit index signature that requires. */
import type {
  AgentId,
  DelegationId,
  Digest,
  OperationId,
  OrganizationId,
  PrincipalId,
  RunId,
  SessionId,
  ToolId,
} from "./identity.ts";
import type { ToolDefinition } from "./tools.ts";

export type ToolCallOutcome = "succeeded" | "failed" | "unknown" | "denied";

// A call can end before it has a principal, a digest, or a policy decision.
// Null rather than an absent key keeps every event a plain JSON value.
export type ToolCallFacts = {
  readonly toolId: ToolId;
  readonly toolVersion: string;
  readonly effect: ToolDefinition["effect"];
  readonly connectorId: string;
  readonly operationId: OperationId;
  readonly argumentDigest: Digest | null;
  readonly actorPrincipalId: PrincipalId | null;
  readonly representedPrincipalId: PrincipalId | null;
  readonly delegationId: DelegationId | null;
  readonly policyVersion: string | null;
};

export type ToolDispatchedPayload = ToolCallFacts & {
  readonly argumentDigest: Digest;
  readonly actorPrincipalId: PrincipalId;
  readonly policyVersion: string;
  readonly approvalId: string | null;
};

export type ToolSettledPayload = ToolCallFacts & {
  readonly approvalId: string | null;
  readonly outcome: ToolCallOutcome;
  readonly reason: string | null;
};

type AuditEvent<Name extends string, Payload> = {
  readonly eventId: string;
  readonly organizationId: OrganizationId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly kind: "audit";
  readonly name: Name;
  readonly occurredAt: number;
  readonly payload: Payload;
};

export type ToolAuditEvent =
  | AuditEvent<"tool.dispatched", ToolDispatchedPayload>
  | AuditEvent<"tool.settled", ToolSettledPayload>;
