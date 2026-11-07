import { Schema } from "effect";

import { ChatApproval } from "./session-service.ts";
import { canonicalToolArguments } from "./tools.ts";
import { TriggerSchema } from "./triggers.ts";
import {
  TeamCommandSchema,
  TeamReportDeliverySchema,
  TeamReportReceiptSchema,
  WorkAdmissionSchema,
  WorkKeySchema,
} from "./work.ts";

export const TeamEventMetadataSchema = Schema.Struct({
  id: TriggerSchema.fields.id,
  digest: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
  origin: TriggerSchema.fields.origin,
  reply: TriggerSchema.fields.reply,
});
export const TeamEventCommandSchema = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("event-command"),
  command: TeamCommandSchema.members[1],
  event: TeamEventMetadataSchema,
});
export const TeamCommandTransportSchema = Schema.Union([
  TeamCommandSchema,
  TeamEventCommandSchema,
]);
export type TeamCommandTransport = typeof TeamCommandTransportSchema.Type;
export type TeamEventCommand = typeof TeamEventCommandSchema.Type;
export type TeamEventMetadata = typeof TeamEventMetadataSchema.Type;

export const normalizeTeamCommand = (input: unknown) => {
  const wire = Schema.decodeUnknownSync(TeamCommandTransportSchema, {
    onExcessProperty: "error",
  })(input);
  return wire.kind === "event-command"
    ? { wire, command: wire.command, event: wire.event }
    : { wire, command: wire, event: null };
};
export const TeamEventReturnSchema = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("event-return"),
  work: WorkAdmissionSchema,
  eventId: TriggerSchema.fields.id,
  eventDigest: TeamEventMetadataSchema.fields.digest,
});
export type TeamEventReturn = typeof TeamEventReturnSchema.Type;
export const TeamEventReturnReceiptSchema = Schema.Struct({
  eventId: TriggerSchema.fields.id,
  key: WorkKeySchema,
  accepted: Schema.Boolean,
});
export const TeamApprovalRequestSchema = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("approval-request"),
  work: WorkAdmissionSchema,
  approval: ChatApproval,
}).check(
  Schema.makeFilter(
    ({ work, approval }) =>
      approval.workId === work.key.workId && approval.state === "pending"
  )
);
export type TeamApprovalRequest = typeof TeamApprovalRequestSchema.Type;
export const TeamApprovalReceiptSchema = Schema.Struct({
  approvalId: ChatApproval.fields.approvalId,
  key: WorkKeySchema,
  accepted: Schema.Boolean,
});
export type TeamApprovalReceipt = typeof TeamApprovalReceiptSchema.Type;
export const TeamApprovalDecisionSchema = Schema.Struct({
  work: WorkAdmissionSchema,
  approvalId: ChatApproval.fields.approvalId,
  decision: Schema.Literals(["allow", "deny"]),
});
export type TeamApprovalDecision = typeof TeamApprovalDecisionSchema.Type;
export const TeamReportTransportSchema = Schema.Union([
  TeamReportDeliverySchema,
  TeamEventReturnSchema,
  TeamApprovalRequestSchema,
]);
export type TeamReportTransportMessage = typeof TeamReportTransportSchema.Type;
export const normalizeTeamReport = (input: unknown) => {
  const wire = Schema.decodeUnknownSync(TeamReportTransportSchema, {
    onExcessProperty: "error",
  })(input);
  if (!("kind" in wire)) {
    return {
      kind: "report" as const,
      wire,
      key: wire.report.key,
      sourceEventAddress: wire.sourceEventAddress,
      path: "/team-report" as const,
    };
  }
  return wire.kind === "event-return"
    ? {
        kind: "event-return" as const,
        wire,
        key: wire.work.key,
        sourceEventAddress: wire.work.sourceEventAddress,
        path: "/team-event-return" as const,
      }
    : {
        kind: "approval-request" as const,
        wire,
        key: wire.work.key,
        sourceEventAddress: wire.work.sourceEventAddress,
        path: "/team-approval" as const,
      };
};
const sameKey = (left: unknown, right: unknown): boolean =>
  canonicalToolArguments(left) === canonicalToolArguments(right);
export const teamReportReceiptMatches = (
  delivery: ReturnType<typeof normalizeTeamReport>,
  input: unknown
): boolean => {
  const decode = { onExcessProperty: "error" } as const;
  switch (delivery.kind) {
    case "report": {
      const receipt = Schema.decodeUnknownSync(
        TeamReportReceiptSchema,
        decode
      )(input);
      return (
        receipt.reportId === delivery.wire.report.id &&
        sameKey(receipt.key, delivery.key)
      );
    }
    case "event-return": {
      const receipt = Schema.decodeUnknownSync(
        TeamEventReturnReceiptSchema,
        decode
      )(input);
      return (
        receipt.eventId === delivery.wire.eventId &&
        sameKey(receipt.key, delivery.key)
      );
    }
    case "approval-request": {
      const receipt = Schema.decodeUnknownSync(
        TeamApprovalReceiptSchema,
        decode
      )(input);
      return (
        receipt.approvalId === delivery.wire.approval.approvalId &&
        sameKey(receipt.key, delivery.key)
      );
    }
    default: {
      const exhaustive: never = delivery;
      return exhaustive;
    }
  }
};
