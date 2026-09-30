import type { EventAddress, EventEnvelope } from "@cerebro/contracts/events";
import type {
  Digest,
  ExecutionContext,
  OperationId,
  PrincipalId,
  RunId,
} from "@cerebro/contracts/identity";
import type {
  RunState,
  SessionReceipt,
  SessionStreamItem,
  ContentDependencies,
} from "@cerebro/contracts/session";
import type {
  Approval,
  ToolExecution,
  ToolInvocation,
} from "@cerebro/contracts/tools";

import type { PinnedAgentConfig } from "./pinned-agent.ts";

export interface StoredRun {
  readonly runId: RunId;
  readonly eventId: EventEnvelope["eventId"];
  readonly operationId: OperationId;
  readonly requestDigest: Digest;
  readonly agent: PinnedAgentConfig;
  readonly context: ExecutionContext;
  readonly prompt: string;
  readonly state: RunState["state"];
  readonly createdAt: number;
  readonly endedAt?: number;
  readonly output?: string;
  readonly opencodeSessionId?: string;
  readonly messageId?: string;
  readonly dependencies?: ContentDependencies;
  readonly modelPrompt?: string;
}

export interface StoredInvocation {
  readonly operationId: OperationId;
  readonly runId: RunId;
  readonly argumentDigest: Digest;
  readonly invocation: ToolInvocation;
  readonly idempotent: boolean;
  readonly state: ToolInvocation["state"];
  readonly result?: ToolExecution;
  readonly providerReceipt?: string;
  readonly attemptId?: string;
  readonly sdkCallIds: readonly string[];
  readonly originModelAttemptId: string;
  readonly boundModelAttemptId: string;
}

export interface OutboxEvent {
  readonly eventId: string;
  readonly organizationId: EventAddress["organizationId"];
  readonly agentId: EventAddress["agentId"];
  readonly sessionId: EventAddress["sessionId"];
  readonly runId: RunId;
  readonly kind: "audit" | "usage";
  readonly name: string;
  readonly occurredAt: number;
  readonly payload: unknown;
}

export type StoredApprovalRequest = Omit<Approval, "approverId">;

export interface InboxRecord {
  readonly event: EventEnvelope;
  readonly operationId: OperationId;
  readonly requestDigest: Digest;
  readonly receipt: SessionReceipt;
}

export type ControlRecord =
  | {
      readonly kind: "approve";
      readonly digest: Digest;
      readonly approvalId: string;
      readonly approverId: PrincipalId;
      readonly state: RunState;
    }
  | {
      readonly kind: "cancel";
      readonly digest: Digest;
      readonly runId: RunId;
      readonly state: RunState;
    };

export interface LedgerValueMap {
  readonly identity: { readonly kind: string; readonly digest: Digest };
  readonly inbox: InboxRecord;
  readonly submission: {
    readonly requestDigest: Digest;
    readonly receipt: SessionReceipt;
  };
  readonly decision: {
    readonly choice: "run";
    readonly inputDigest: Digest;
    readonly modelVersion: string;
    readonly usage: { readonly unit: string; readonly units: number };
  };
  readonly run: StoredRun;
  readonly invocation: StoredInvocation;
  readonly approval: StoredApprovalRequest;
  readonly "approval-event": {
    readonly approvalId: string;
    readonly grantedAt: number;
    readonly operationId: OperationId;
  };
  readonly "approval-grant": Approval;
  readonly control: ControlRecord;
  readonly cancellation: {
    readonly cancelledAt: number;
    readonly runId: RunId;
  };
  readonly stream: SessionStreamItem;
  readonly "tool-output": Extract<SessionStreamItem, { type: "tool" }>;
  readonly outbox: OutboxEvent;
  readonly usage: OutboxEvent;
}

export type LedgerKind = keyof LedgerValueMap;
export type LedgerValue = LedgerValueMap[LedgerKind];
