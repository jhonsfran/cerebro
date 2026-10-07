/* oxlint-disable no-redeclare -- Effect service tags and schemas share their TypeScript type name. */
import { Context } from "effect";
import type { Effect, Scope, Stream } from "effect";

import type { EventAddress, EventEnvelope } from "./events.ts";
import type { ContractFailure } from "./failures.ts";
import type { Digest, ExecutionContext, RunId } from "./identity.ts";
import type { EffectOptions, ReadOptions } from "./port.ts";
import type {
  DomainSnapshot,
  DomainUpdate,
  Observation,
  ObservationRequest,
  SubmissionMode,
  SubmitCommand,
} from "./session-service.ts";
import type { AgentDefinition, RunState, SessionReceipt } from "./session.ts";
import type { BoundApproval } from "./tool-service.ts";

export interface EngineSubmission {
  readonly mode?: "follow-up" | "steer";
  readonly requestId: EventEnvelope["eventId"];
  readonly inputDigest: Digest;
  readonly runId: RunId;
  readonly event: EventEnvelope;
}
export interface EngineConversation {
  readonly submit: (
    submission: EngineSubmission,
    options: ReadOptions
  ) => Effect.Effect<
    { readonly runId: RunId; readonly replayed: boolean },
    ContractFailure
  >;
  readonly inspect: (
    options: ReadOptions
  ) => Effect.Effect<readonly RunState[], ContractFailure>;
  readonly observe: (
    options: ReadOptions
  ) => Stream.Stream<DomainUpdate, ContractFailure, Scope.Scope>;
  readonly approve: (
    approval: BoundApproval,
    options: ReadOptions
  ) => Effect.Effect<RunState, ContractFailure>;
  readonly cancel: (
    runId: RunId,
    options: ReadOptions
  ) => Effect.Effect<RunState, ContractFailure>;
  // Native session stop also withdraws queued inputs. Returns affected runs.
  readonly stop: (
    options: ReadOptions
  ) => Effect.Effect<readonly RunState[], ContractFailure>;
  readonly release: Effect.Effect<void, never>;
}
export interface ExecutionEngine {
  readonly open: (
    address: EventAddress,
    pinnedAgent: AgentDefinition,
    options: ReadOptions
  ) => Effect.Effect<EngineConversation, ContractFailure, Scope.Scope>;
}
export const ExecutionEngine = Context.Service<ExecutionEngine>(
  "@cerebro/ExecutionEngine"
);

export interface DurableHandoff {
  readonly address: EventAddress;
  readonly submission: EngineSubmission;
  readonly agentVersion: number;
  readonly admittedRevision: number;
  readonly revision: number;
  readonly run: RunState;
  readonly approvals: readonly BoundApproval[];
  readonly mode: SubmissionMode;
  readonly replaceStopped: boolean;
  readonly engineAccepted: boolean;
  // PiHarness acceptance includes its durable inbox and Lifecycle wake.
  readonly acknowledged: boolean;
  readonly projectedRevision: number;
}
// Atomic compare-and-commit operations only. Network work never enters a transaction.
export type HandoffTransition =
  | {
      readonly type: "approval";
      readonly runId: RunId;
      readonly approval: BoundApproval;
    }
  | {
      readonly type: "run-state";
      readonly runId: RunId;
      readonly run: RunState;
    }
  | { readonly type: "engine-accepted"; readonly runId: RunId }
  | { readonly type: "replace-stopped"; readonly runId: RunId }
  | { readonly type: "acknowledged"; readonly runId: RunId }
  | {
      readonly type: "projected";
      readonly runId: RunId;
      readonly update: DomainUpdate;
    }
  | {
      readonly type: "projected-batch";
      readonly runId: RunId;
      readonly updates: readonly [DomainUpdate, ...DomainUpdate[]];
    };
export interface SessionStore {
  readonly admit: (
    command: SubmitCommand,
    pinnedAgent: AgentDefinition,
    options: EffectOptions
  ) => Effect.Effect<DurableHandoff, ContractFailure>;
  readonly commit: (
    address: EventAddress,
    expectedRevision: number,
    transition: HandoffTransition,
    options: EffectOptions
  ) => Effect.Effect<DurableHandoff, ContractFailure>;
  readonly receipt: (
    address: EventAddress,
    requestId: EventEnvelope["eventId"],
    context: ExecutionContext,
    options: ReadOptions
  ) => Effect.Effect<SessionReceipt, ContractFailure>;
  readonly recover: (
    address: EventAddress,
    options: ReadOptions
  ) => Effect.Effect<readonly DurableHandoff[], ContractFailure>;
  readonly attach: (
    address: EventAddress,
    context: ExecutionContext,
    request: ObservationRequest,
    options: ReadOptions
  ) => Stream.Stream<Observation, ContractFailure, Scope.Scope>;
  readonly snapshot: (
    address: EventAddress,
    context: ExecutionContext,
    options: ReadOptions
  ) => Effect.Effect<DomainSnapshot, ContractFailure>;
}
export const SessionStore = Context.Service<SessionStore>(
  "@cerebro/SessionStore"
);
