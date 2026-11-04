import { Effect, Schema } from "effect";

import type { BrandedId } from "./identity.ts";
import type { ContentDependencies } from "./session.ts";

const identifier = <Name extends string>() =>
  Schema.declare<BrandedId<Name>>(
    (value): value is BrandedId<Name> =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 512 &&
      value.trim() === value
  );
const text = Schema.NonEmptyString.check(Schema.isMaxLength(16_000));
const timestamp = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
);

export const WorkIdSchema = identifier<"WorkId">();
export type WorkId = typeof WorkIdSchema.Type;
export const WorkCommandIdSchema = identifier<"WorkCommandId">();
export const WorkReportIdSchema = identifier<"WorkReportId">();

export const WorkKeySchema = Schema.Struct({
  organizationId: identifier<"OrganizationId">(),
  ownerPrincipalId: identifier<"PrincipalId">(),
  workId: WorkIdSchema,
});
export type WorkKey = typeof WorkKeySchema.Type;

export const RolePinSchema = Schema.Struct({
  agentId: identifier<"AgentId">(),
  agentVersion: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  ),
});
export type RolePin = typeof RolePinSchema.Type;

export const SlackThreadSchema = Schema.Struct({
  channelId: identifier<"SlackChannelId">(),
  rootTimestamp: Schema.String.check(Schema.isPattern(/^\d{1,16}\.\d{6}$/u)),
  workspaceId: identifier<"SlackWorkspaceId">(),
});
export type SlackThread = typeof SlackThreadSchema.Type;

export const WorkLimitsSchema = Schema.Struct({
  maxTeams: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 })),
  maxTurns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  maxWorkers: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 })),
  timeoutMs: Schema.Int.check(
    Schema.isBetween({ minimum: 1000, maximum: 600_000 })
  ),
});
export type WorkLimits = typeof WorkLimitsSchema.Type;

export const CoordinationProfileSchema = Schema.Struct({
  leadAgentId: RolePinSchema.fields.agentId,
  maxTeams: WorkLimitsSchema.fields.maxTeams.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(2))
  ),
  maxTurns: WorkLimitsSchema.fields.maxTurns.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(8))
  ),
  maxWorkers: WorkLimitsSchema.fields.maxWorkers.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(2))
  ),
  timeoutMs: WorkLimitsSchema.fields.timeoutMs.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(600_000))
  ),
  workerAgentId: RolePinSchema.fields.agentId,
});
export type CoordinationProfile = typeof CoordinationProfileSchema.Type;

export const WorkAdmissionSchema = Schema.Struct({
  admittedAt: timestamp,
  deadlineAt: timestamp,
  goal: text,
  key: WorkKeySchema,
  lead: RolePinSchema,
  limits: WorkLimitsSchema,
  sourceEventAddress: Schema.Struct({
    agentId: identifier<"AgentId">(),
    conversationId: identifier<"ConversationId">(),
    organizationId: identifier<"OrganizationId">(),
    sessionId: identifier<"SessionId">(),
  }),
  sourceSlackThread: SlackThreadSchema,
  worker: RolePinSchema,
}).check(
  Schema.makeFilter(
    (work) =>
      work.key.organizationId === work.sourceEventAddress.organizationId &&
      work.deadlineAt > work.admittedAt &&
      work.deadlineAt - work.admittedAt <= work.limits.timeoutMs
  )
);
export type WorkAdmission = typeof WorkAdmissionSchema.Type;

export const TeamCommandSchema = Schema.Union([
  Schema.Struct({
    id: WorkCommandIdSchema,
    kind: Schema.Literal("start"),
    work: WorkAdmissionSchema,
  }),
  Schema.Struct({
    id: WorkCommandIdSchema,
    kind: Schema.Literal("input"),
    text,
    work: WorkAdmissionSchema,
  }),
  Schema.Struct({
    id: WorkCommandIdSchema,
    kind: Schema.Literal("cancel"),
    work: WorkAdmissionSchema,
  }),
]);
export type TeamCommand = typeof TeamCommandSchema.Type;

export const WorkStatusSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("accepted") }),
  Schema.Struct({ kind: Schema.Literal("running") }),
  Schema.Struct({
    commandId: WorkCommandIdSchema,
    kind: Schema.Literal("cancelled"),
  }),
  Schema.Struct({
    kind: Schema.Literal("completed"),
    reportId: WorkReportIdSchema,
  }),
  Schema.Struct({ kind: Schema.Literal("failed"), reason: text }),
]);
export type WorkStatus = typeof WorkStatusSchema.Type;

const contentDependenciesSchema = Schema.Struct({
  sourceIds: Schema.Array(identifier<"SourceId">()).check(
    Schema.isMaxLength(512)
  ),
  toolIds: Schema.Array(
    Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(512))
  ).check(Schema.isMaxLength(256)),
}) satisfies Schema.Codec<ContentDependencies>;
const reportFields = {
  contentDependencies: contentDependenciesSchema,
  id: WorkReportIdSchema,
  key: WorkKeySchema,
};
export const WorkReportSchema = Schema.Union([
  Schema.Struct({
    ...reportFields,
    kind: Schema.Literal("completed"),
    text,
  }),
  Schema.Struct({
    ...reportFields,
    kind: Schema.Literal("failed"),
    reason: text,
  }),
  Schema.Struct({ ...reportFields, kind: Schema.Literal("cancelled") }),
]);
export type WorkReport = typeof WorkReportSchema.Type;

export const TeamCommandReceiptSchema = Schema.Union([
  Schema.Struct({
    commandId: WorkCommandIdSchema,
    key: WorkKeySchema,
    kind: Schema.Literal("accepted"),
  }),
  Schema.Struct({
    commandId: WorkCommandIdSchema,
    key: WorkKeySchema,
    kind: Schema.Literal("rejected"),
    reason: Schema.Literals([
      "conflict",
      "cancelled",
      "expired",
      "terminal",
      "revoked",
    ]),
  }),
]);
export type TeamCommandReceipt = typeof TeamCommandReceiptSchema.Type;

export const workCellName = (key: WorkKey): string =>
  JSON.stringify([
    "team-v1",
    key.organizationId,
    key.ownerPrincipalId,
    key.workId,
  ]);

export const workStartOperationId = (key: WorkKey): string =>
  JSON.stringify([
    "work-start-v1",
    key.organizationId,
    key.ownerPrincipalId,
    key.workId,
  ]);

export const transitionWorkStatus = (
  current: WorkStatus,
  next: WorkStatus
): WorkStatus => {
  if (
    current.kind === "cancelled" ||
    current.kind === "completed" ||
    current.kind === "failed" ||
    (current.kind === "running" && next.kind === "accepted")
  ) {
    return current;
  }
  return next;
};
