import type { EventAddress, EventEnvelope } from "./events.ts";
import type {
  AgentId,
  ExecutionContext,
  OperationId,
  OrganizationId,
  RunId,
  SessionId,
  SourceId,
} from "./identity.ts";
import type { Provenance } from "./memory.ts";
import type { Action, Resource } from "./policy.ts";
import type { EffectOptions, PortResult, ReadOptions } from "./port.ts";

export type RunState =
  | {
      readonly state: "queued" | "running" | "waiting-for-approval";
      readonly runId: RunId;
    }
  | {
      readonly state: "completed";
      readonly runId: RunId;
      readonly completedAt: number;
    }
  | {
      readonly state: "failed" | "cancelled";
      readonly runId: RunId;
      readonly endedAt: number;
    }
  | {
      readonly state: "unknown-outcome";
      readonly runId: RunId;
      readonly operationId: OperationId;
    };

export interface SessionSnapshot {
  readonly address: EventAddress;
  readonly agentVersion: number;
  readonly runs: readonly RunState[];
  readonly cursor: string;
}

export type SessionCommand =
  | { readonly type: "submit"; readonly event: EventEnvelope }
  | {
      readonly type: "approve";
      readonly address: EventAddress;
      readonly approvalId: string;
      readonly context: ExecutionContext;
    }
  | {
      readonly type: "cancel";
      readonly address: EventAddress;
      readonly runId: RunId;
      readonly context: ExecutionContext;
    };

export interface SessionReceipt {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly acceptedEventId: EventEnvelope["eventId"];
  readonly replayed: boolean;
}

export interface ContentDependencies {
  readonly sourceIds: readonly SourceId[];
  readonly toolIds: readonly string[];
}

export type SessionStreamItem =
  | { readonly type: "run"; readonly run: RunState; readonly cursor: string }
  | {
      readonly type: "output";
      readonly runId: RunId;
      readonly text: string;
      readonly dependencies?: ContentDependencies;
      readonly cursor: string;
    }
  | {
      readonly type: "citation";
      readonly runId: RunId;
      readonly citation: Provenance;
      readonly dependencies: ContentDependencies;
      readonly cursor: string;
    }
  | {
      readonly type: "tool";
      readonly runId: RunId;
      readonly operationId: OperationId;
      readonly toolId: string;
      readonly output: unknown;
      readonly dependencies: ContentDependencies;
      readonly cursor: string;
    }
  | {
      readonly type: "approval";
      readonly runId: RunId;
      readonly approvalId: string;
      readonly cursor: string;
    };

export interface AgentGrant {
  readonly action: Action;
  readonly resource: Resource;
}

export interface AgentDefinition {
  readonly organizationId: OrganizationId;
  readonly agentId: AgentId;
  readonly version: number;
  readonly instructions: string;
  readonly model: string;
  readonly enabledToolIds: readonly string[];
  readonly grants: readonly AgentGrant[];
}

export interface AgentRepository {
  readonly get: (
    organizationId: OrganizationId,
    agentId: AgentId,
    version: number | "latest",
    options: ReadOptions
  ) => Promise<PortResult<AgentDefinition>>;
  readonly publish: (
    definition: AgentDefinition,
    expectedVersion: number | undefined,
    options: EffectOptions
  ) => Promise<PortResult<AgentDefinition>>;
}
