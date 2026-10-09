/* oxlint-disable no-redeclare -- Effect service tags and schemas share their TypeScript type name. */
import { Context, Schema } from "effect";
import type { Effect, Scope, Stream } from "effect";

import type { EventAddress } from "./events.ts";
import type { ContractFailure } from "./failures.ts";
import type { ExecutionContext, OperationId, RunId } from "./identity.ts";
import type { EffectOptions, ReadOptions } from "./port.ts";
import type { SessionCommand, SessionReceipt } from "./session.ts";
import { canonicalToolArguments } from "./tools.ts";

const identifier = <Name extends string>() =>
  Schema.declare<string & { readonly __brand: Name }>(
    (value): value is string & { readonly __brand: Name } =>
      typeof value === "string" && value.length > 0 && value.trim() === value
  );
const address = Schema.Struct({
  agentId: identifier<"AgentId">(),
  conversationId: identifier<"ConversationId">(),
  organizationId: identifier<"OrganizationId">(),
  sessionId: identifier<"SessionId">(),
});
const runId = identifier<"RunId">();
const executionId = identifier<"ExecutionId">();
const memberRunIds = Schema.NonEmptyArray(runId).check(
  Schema.makeFilter((values) => new Set(values).size === values.length)
);
export const ExecutionState = Schema.Struct({
  executionId,
  runIds: memberRunIds,
});
export type ExecutionState = typeof ExecutionState.Type;
const operationId = identifier<"OperationId">();
const dependencies = Schema.Struct({
  sourceIds: Schema.Array(identifier<"SourceId">()),
  toolIds: Schema.Array(Schema.String),
});
const run = Schema.Union([
  Schema.Struct({
    runId,
    state: Schema.Literals(["queued", "running", "waiting-for-approval"]),
  }),
  Schema.Struct({
    completedAt: Schema.Number,
    runId,
    state: Schema.Literal("completed"),
  }),
  Schema.Struct({
    endedAt: Schema.Number,
    runId,
    state: Schema.Literals(["failed", "cancelled"]),
  }),
  Schema.Struct({
    operationId,
    runId,
    state: Schema.Literal("unknown-outcome"),
  }),
]);
const provenance = Schema.Struct({
  observedAt: Schema.Number,
  sourceId: identifier<"SourceId">(),
  sourceUri: Schema.String,
  sourceVersion: Schema.String,
});
const jsonValue = Schema.Unknown.check(
  Schema.makeFilter((value) => {
    try {
      canonicalToolArguments(value);
      return true;
    } catch {
      return false;
    }
  })
);
export const CanonicalOutput = Schema.Struct({
  answerId: identifier<"AnswerId">(),
  citations: Schema.Array(provenance),
  dependencies,
  executionId,
  runId,
  runIds: memberRunIds,
  text: Schema.String,
}).check(Schema.makeFilter((value) => value.runId === value.runIds[0]));
export type CanonicalOutput = typeof CanonicalOutput.Type;
export const UserMessage = Schema.Struct({
  eventId: identifier<"EventId">(),
  mode: Schema.Literals(["follow-up", "steer", "replace"]),
  occurredAt: Schema.Number.check(Schema.isFinite()),
  runId,
  text: Schema.String,
});
export type UserMessage = typeof UserMessage.Type;

// Public approval state is a projection, not the private BoundApproval permit.
export const ApprovalState = Schema.Struct({
  approvalId: Schema.NonEmptyString,
  expiresAt: Schema.Number.check(Schema.isFinite()),
  operationId,
  runId,
  state: Schema.Literals([
    "pending",
    "allowed",
    "denied",
    "expired",
    "cancelled",
  ]),
});
export type ApprovalState = typeof ApprovalState.Type;

export const ToolState = Schema.Struct({
  arguments: jsonValue,
  dependencies,
  effect: Schema.Literals(["read", "write"]),
  operationId,
  output: jsonValue,
  runId,
  state: Schema.Literals([
    "requested",
    "waiting-for-approval",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "unknown-outcome",
  ]),
  toolId: identifier<"ToolId">(),
  toolVersion: Schema.NonEmptyString,
});
export type ToolState = typeof ToolState.Type;

export const DomainSnapshot = Schema.Struct({
  address,
  agentVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  approvals: Schema.Array(ApprovalState),
  executions: Schema.Array(ExecutionState),
  outputs: Schema.Array(CanonicalOutput),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  runs: Schema.Array(run),
  tools: Schema.Array(ToolState),
  userMessages: Schema.Array(UserMessage),
}).check(
  Schema.makeFilter((snapshot) => {
    const executionIds = new Set(
      snapshot.executions.map((value) => value.executionId)
    );
    const memberIds = snapshot.executions.flatMap((value) => value.runIds);
    if (
      executionIds.size !== snapshot.executions.length ||
      new Set(memberIds).size !== memberIds.length ||
      new Set(snapshot.outputs.map((value) => value.answerId)).size !==
        snapshot.outputs.length ||
      new Set(snapshot.outputs.map((value) => value.executionId)).size !==
        snapshot.outputs.length
    ) {
      return false;
    }
    return snapshot.outputs.every((value) => {
      const execution = snapshot.executions.find(
        (item) => item.executionId === value.executionId
      );
      return (
        execution !== undefined &&
        execution.runIds.length === value.runIds.length &&
        execution.runIds.every(
          (member, index) => member === value.runIds[index]
        )
      );
    });
  })
);
export type DomainSnapshot = typeof DomainSnapshot.Type;

export const PartialAssistantMessage = Schema.Struct({
  executionId,
  runId,
  text: Schema.String,
  thinking: Schema.String,
});
export type PartialAssistantMessage = typeof PartialAssistantMessage.Type;

export const DomainUpdate = Schema.Union([
  Schema.Struct({ run, type: Schema.Literal("run") }),
  Schema.Struct({
    execution: ExecutionState,
    type: Schema.Literal("execution"),
  }),
  Schema.Struct({ message: UserMessage, type: Schema.Literal("user-message") }),
  Schema.Struct({
    executionId,
    runId,
    text: Schema.String,
    type: Schema.Literal("provisional-text"),
  }),
  Schema.Struct({
    executionId,
    runId,
    text: Schema.String,
    type: Schema.Literal("provisional-thinking"),
  }),
  Schema.Struct({
    output: CanonicalOutput,
    type: Schema.Literal("canonical-output"),
  }),
  Schema.Struct({
    ...ApprovalState.fields,
    type: Schema.Literal("approval"),
  }),
  Schema.Struct({
    ...ToolState.fields,
    type: Schema.Literal("tool"),
  }),
  Schema.Struct({
    citation: provenance,
    dependencies,
    executionId,
    runId,
    text: Schema.String,
    type: Schema.Literal("citation"),
  }),
]);
export type DomainUpdate = typeof DomainUpdate.Type;

const frameMetadata = {
  accessGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  address,
  epoch: Schema.NonEmptyString,
  schemaVersion: Schema.Literal(1),
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
};
export const Observation = Schema.Union([
  Schema.Struct({
    ...frameMetadata,
    partial: Schema.optional(Schema.Array(PartialAssistantMessage)),
    reason: Schema.Literals(["attach", "overflow", "reconnect"]),
    snapshot: DomainSnapshot,
    type: Schema.Literal("snapshot"),
  }),
  Schema.Struct({
    ...frameMetadata,
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    type: Schema.Literal("update"),
    update: DomainUpdate,
  }),
  Schema.Struct({
    ...frameMetadata,
    reason: Schema.Literals(["revoked", "unauthorized"]),
    type: Schema.Literal("access-denied"),
  }),
]);
export type Observation = typeof Observation.Type;
export interface ObservationRequest {
  readonly accessGeneration: number;
  readonly afterRevision?: number;
}
export type SubmissionMode = "follow-up" | "steer" | "replace";
export type SubmitCommand = Extract<SessionCommand, { type: "submit" }> & {
  readonly mode?: SubmissionMode;
};
export type ApprovalCommand = Extract<SessionCommand, { type: "approve" }> & {
  readonly runId: RunId;
  readonly decision: "allow" | "deny";
};
export interface SessionService {
  readonly reconcile: (
    command: {
      readonly address: EventAddress;
      readonly context: ExecutionContext;
      readonly operationId: OperationId;
      readonly runId: RunId;
    },
    options: EffectOptions
  ) => Effect.Effect<ToolState, ContractFailure>;
  readonly submit: (
    command: SubmitCommand,
    options: EffectOptions
  ) => Effect.Effect<SessionReceipt, ContractFailure>;
  readonly approve: (
    command: ApprovalCommand,
    options: EffectOptions
  ) => Effect.Effect<DomainSnapshot["runs"][number], ContractFailure>;
  readonly cancel: (
    command: Extract<SessionCommand, { type: "cancel" }>,
    options: EffectOptions
  ) => Effect.Effect<DomainSnapshot["runs"][number], ContractFailure>;
  readonly inspect: (
    address: EventAddress,
    context: ExecutionContext,
    options: ReadOptions
  ) => Effect.Effect<DomainSnapshot, ContractFailure>;
  readonly stream: (
    address: EventAddress,
    context: ExecutionContext,
    request: ObservationRequest,
    options: ReadOptions
  ) => Stream.Stream<Observation, ContractFailure, Scope.Scope>;
}
export const SessionService = Context.Service<SessionService>(
  "@cerebro/SessionService"
);
