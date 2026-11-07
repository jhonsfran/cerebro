/* oxlint-disable no-redeclare -- Schemas define their corresponding TypeScript types. */
import { Schema } from "effect";

import { BotEventAddressSchema } from "./bot-events.ts";
import type { EventAddress } from "./events.ts";
import type { ExecutionContext } from "./identity.ts";
import { RolePinSchema, WorkAdmissionSchema, WorkIdSchema } from "./work.ts";

export const INSPECTION_PAGE_SIZE = 24;
export const INSPECTION_TEXT_LENGTH = 2000;
export const INSPECTION_MAX_BYTES = 262_144;
const identifier = Schema.NonEmptyString.check(Schema.isMaxLength(2048));
const cursor = Schema.String.check(Schema.isMaxLength(4096));
const count = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0)
);
const time = Schema.Number.check(Schema.isFinite());
const slot = Schema.Literals([0, 1, 2]);
export const InspectionText = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(INSPECTION_TEXT_LENGTH)),
  truncated: Schema.Boolean,
});
export const TeamInspectionQuery = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("team"), workId: WorkIdSchema }),
  Schema.Struct({
    kind: Schema.Literal("tasks"),
    workId: WorkIdSchema,
    role: slot,
    cursor: Schema.optional(cursor),
  }),
  Schema.Struct({
    kind: Schema.Literal("transcript"),
    workId: WorkIdSchema,
    role: slot,
    cursor: Schema.optional(cursor),
  }),
]);
export type TeamInspectionQuery = typeof TeamInspectionQuery.Type;
export const InspectionQuery = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("overview") }),
  Schema.Struct({
    kind: Schema.Literal("history"),
    cursor: Schema.optional(cursor),
  }),
  Schema.Struct({
    kind: Schema.Literal("events"),
    cursor: Schema.optional(cursor),
  }),
  TeamInspectionQuery,
]);
export type InspectionQuery = typeof InspectionQuery.Type;
export const PrivateInspectionQuery = Schema.Struct({
  work: WorkAdmissionSchema,
  query: TeamInspectionQuery,
});
export type PrivateInspectionQuery = typeof PrivateInspectionQuery.Type;
export const InspectionTokens = Schema.Struct({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
  totalTokens: count,
});
export type InspectionTokens = typeof InspectionTokens.Type;
export const InspectionResult = Schema.Struct({
  id: identifier,
  kind: Schema.Literals(["completed", "failed", "cancelled"]),
  content: InspectionText,
});
export type InspectionResult = typeof InspectionResult.Type;
export const InspectionWork = Schema.Struct({
  workId: WorkIdSchema,
  goal: InspectionText,
  status: Schema.Literals([
    "queued",
    "accepted",
    "running",
    "completed",
    "failed",
    "cancelled",
  ]),
  admittedAt: time,
  deadlineAt: time,
  dispatched: Schema.Boolean,
  reservationHeld: Schema.Boolean,
  result: Schema.NullOr(InspectionResult),
  subscriptions: Schema.Array(
    Schema.Struct({
      workspaceId: identifier,
      channelId: identifier,
      rootTimestamp: identifier,
    })
  ).check(Schema.isMaxLength(8)),
});
export type InspectionWork = typeof InspectionWork.Type;
export const InspectionRole = Schema.Struct({
  slot,
  nativeId: identifier,
  definition: RolePinSchema,
  modelId: Schema.NullOr(identifier),
  running: Schema.Boolean,
  ownerTaskId: Schema.NullOr(identifier),
  requestId: Schema.NullOr(identifier),
  usage: InspectionTokens,
  toolUsage: InspectionTokens,
  attempt: Schema.NullOr(count),
  retryAt: Schema.NullOr(time),
});
export type InspectionRole = typeof InspectionRole.Type;
export const InspectionTeam = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("not-started") }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.Literal("execution-unavailable"),
  }),
  Schema.Struct({
    kind: Schema.Literal("available"),
    cell: identifier,
    phase: Schema.Literals([
      "waiting",
      "running",
      "completed",
      "failed",
      "cancelled",
    ]),
    sealed: Schema.Boolean,
    requestReservations: count,
    requestLimit: count,
    roles: Schema.Array(InspectionRole).check(Schema.isMaxLength(3)),
    result: Schema.NullOr(InspectionResult),
    monetaryCost: Schema.Literal("unavailable"),
  }),
]);
export type InspectionTeam = typeof InspectionTeam.Type;
export const InspectionTask = Schema.Struct({
  id: identifier,
  kind: identifier,
  version: count,
  ownerTaskId: Schema.NullOr(identifier),
  background: Schema.Boolean,
  abortRequested: Schema.Boolean,
  status: Schema.Literals([
    "pending",
    "running",
    "waiting",
    "completing",
    "terminal",
  ]),
  outcome: Schema.NullOr(
    Schema.Literals(["completed", "failed", "aborted", "orphaned", "faulted"])
  ),
  phase: Schema.NullOr(identifier),
  attempt: Schema.NullOr(count),
  retryAt: Schema.NullOr(time),
  startedAt: Schema.NullOr(time),
  endedAt: Schema.NullOr(time),
});
export type InspectionTask = typeof InspectionTask.Type;
export const InspectionMessage = Schema.Struct({
  id: identifier,
  entryId: identifier,
  role: Schema.Literals(["user", "assistant"]),
  content: InspectionText,
  modelId: Schema.NullOr(identifier),
  timestamp: time,
  state: Schema.Literals(["complete", "streaming", "interrupted"]),
});
export type InspectionMessage = typeof InspectionMessage.Type;
export const InspectionTool = Schema.Struct({
  id: identifier,
  callId: identifier,
  name: identifier,
  status: Schema.Literals([
    "unknown",
    "pending",
    "running",
    "succeeded",
    "failed",
    "interrupted",
  ]),
  input: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("unavailable") }),
    Schema.Struct({
      kind: Schema.Literal("text"),
      label: identifier,
      content: InspectionText,
    }),
  ]),
  output: Schema.NullOr(InspectionText),
  resultEntryId: Schema.NullOr(identifier),
});
export type InspectionTool = typeof InspectionTool.Type;
export const InspectionEvent = Schema.Struct({
  id: identifier,
  source: identifier,
  route: identifier,
  duplicates: count,
  admission: identifier,
  outcome: Schema.NullOr(identifier),
  workIds: Schema.Array(identifier).check(Schema.isMaxLength(24)),
  returns: Schema.Array(
    Schema.Struct({ workId: identifier, decision: identifier })
  ).check(Schema.isMaxLength(24)),
  reply: Schema.NullOr(
    Schema.Struct({
      answerEntryId: identifier,
      taskId: Schema.NullOr(identifier),
      state: Schema.Literals([
        "pending",
        "sent",
        "unknown",
        "failed",
        "retry",
        "blocked",
      ]),
      attempts: count,
      deadlineAt: time,
      retryAt: Schema.NullOr(time),
      timestamp: Schema.NullOr(identifier),
    })
  ),
});
export type InspectionEvent = typeof InspectionEvent.Type;
const tasksPage = {
  kind: Schema.Literal("tasks"),
  workId: WorkIdSchema,
  role: slot,
  tasks: Schema.Array(InspectionTask).check(
    Schema.isMaxLength(INSPECTION_PAGE_SIZE)
  ),
  next: Schema.NullOr(cursor),
};
const transcriptPage = {
  kind: Schema.Literal("transcript"),
  workId: WorkIdSchema,
  role: slot,
  messages: Schema.Array(InspectionMessage).check(
    Schema.isMaxLength(INSPECTION_PAGE_SIZE)
  ),
  tools: Schema.Array(InspectionTool).check(
    Schema.isMaxLength(INSPECTION_PAGE_SIZE)
  ),
  next: Schema.NullOr(cursor),
};
export const TeamInspectionFrame = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("team"),
    workId: WorkIdSchema,
    team: InspectionTeam,
  }),
  Schema.Struct(tasksPage),
  Schema.Struct(transcriptPage),
]);
export type TeamInspectionFrame = typeof TeamInspectionFrame.Type;
const common = {
  address: BotEventAddressSchema,
  profile: Schema.Struct({ agentVersion: count }),
};
export const InspectionFrame = Schema.Union([
  Schema.Struct({
    ...common,
    kind: Schema.Literal("overview"),
    work: Schema.Array(InspectionWork).check(Schema.isMaxLength(48)),
    refresh: Schema.Boolean,
  }),
  Schema.Struct({
    ...common,
    kind: Schema.Literal("history"),
    work: Schema.Array(InspectionWork).check(Schema.isMaxLength(32)),
    next: Schema.NullOr(cursor),
  }),
  Schema.Struct({
    ...common,
    kind: Schema.Literal("events"),
    events: Schema.Array(InspectionEvent).check(Schema.isMaxLength(32)),
    next: Schema.NullOr(cursor),
  }),
  Schema.Struct({
    ...common,
    kind: Schema.Literal("team"),
    work: InspectionWork,
    team: InspectionTeam,
  }),
  Schema.Struct({ ...common, ...tasksPage }),
  Schema.Struct({ ...common, ...transcriptPage }),
]);
export type InspectionFrame = typeof InspectionFrame.Type;
export interface InspectionRequest {
  readonly address: EventAddress;
  readonly context: ExecutionContext;
  readonly query: InspectionQuery;
  readonly signal?: AbortSignal;
}
export interface InspectionClient {
  readonly read: (request: InspectionRequest) => Promise<InspectionFrame>;
}
