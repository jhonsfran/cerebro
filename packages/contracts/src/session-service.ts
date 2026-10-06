/* oxlint-disable no-redeclare -- Effect service tags and schemas share their TypeScript type name. */
import { Context, Schema } from "effect";
import type { Effect, Scope, Stream } from "effect";

import type { EventAddress } from "./events.ts";
import type { ContractFailure } from "./failures.ts";
import type { ExecutionContext, RunId } from "./identity.ts";
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
const operationId = identifier<"OperationId">();
const dependencies = Schema.Struct({
  sourceIds: Schema.Array(identifier<"SourceId">()),
  toolIds: Schema.Array(Schema.String),
});
const run = Schema.Union(
  Schema.Struct({
    runId,
    state: Schema.Literal("queued", "running", "waiting-for-approval"),
  }),
  Schema.Struct({
    completedAt: Schema.Number,
    runId,
    state: Schema.Literal("completed"),
  }),
  Schema.Struct({
    endedAt: Schema.Number,
    runId,
    state: Schema.Literal("failed", "cancelled"),
  }),
  Schema.Struct({
    operationId,
    runId,
    state: Schema.Literal("unknown-outcome"),
  })
);
const provenance = Schema.Struct({
  observedAt: Schema.Number,
  sourceId: identifier<"SourceId">(),
  sourceUri: Schema.String,
  sourceVersion: Schema.String,
});
const jsonValue = Schema.Unknown.pipe(
  Schema.filter((value) => {
    try {
      canonicalToolArguments(value);
      return true;
    } catch {
      return false;
    }
  })
);
const output = Schema.Struct({
  citations: Schema.Array(provenance),
  dependencies,
  runId,
  text: Schema.String,
});
export const DomainSnapshot = Schema.Struct({
  address,
  agentVersion: Schema.Number.pipe(Schema.int(), Schema.positive()),
  outputs: Schema.Array(output),
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  runs: Schema.Array(run),
});
export type DomainSnapshot = typeof DomainSnapshot.Type;

export const DomainUpdate = Schema.Union(
  Schema.Struct({ run, type: Schema.Literal("run") }),
  Schema.Struct({
    runId,
    text: Schema.String,
    type: Schema.Literal("provisional-text"),
  }),
  Schema.Struct({ output, type: Schema.Literal("canonical-output") }),
  Schema.Struct({
    approvalId: Schema.String,
    operationId,
    runId,
    type: Schema.Literal("approval"),
  }),
  Schema.Struct({
    dependencies,
    operationId,
    output: jsonValue,
    runId,
    state: Schema.Literal(
      "requested",
      "waiting-for-approval",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "unknown-outcome"
    ),
    toolId: identifier<"ToolId">(),
    type: Schema.Literal("tool"),
  }),
  Schema.Struct({
    citation: provenance,
    dependencies,
    runId,
    text: Schema.String,
    type: Schema.Literal("citation"),
  })
);
export type DomainUpdate = typeof DomainUpdate.Type;

const frameMetadata = {
  accessGeneration: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  address,
  epoch: Schema.String.pipe(Schema.nonEmptyString()),
  schemaVersion: Schema.Literal(1),
  sequence: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
};
export const Observation = Schema.Union(
  Schema.Struct({
    ...frameMetadata,
    reason: Schema.Literal("attach", "overflow", "reconnect"),
    snapshot: DomainSnapshot,
    type: Schema.Literal("snapshot"),
  }),
  Schema.Struct({
    ...frameMetadata,
    revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
    type: Schema.Literal("update"),
    update: DomainUpdate,
  }),
  Schema.Struct({
    ...frameMetadata,
    reason: Schema.Literal("revoked", "unauthorized"),
    type: Schema.Literal("access-denied"),
  })
);
export type Observation = typeof Observation.Type;
export interface ObservationRequest {
  readonly accessGeneration: number;
  readonly afterRevision?: number;
}
export type ApprovalCommand = Extract<SessionCommand, { type: "approve" }> & {
  readonly runId: RunId;
  readonly decision: "allow" | "deny";
};
export interface SessionService {
  readonly submit: (
    command: Extract<SessionCommand, { type: "submit" }>,
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
export const SessionService = Context.GenericTag<SessionService>(
  "@cerebro/SessionService"
);
