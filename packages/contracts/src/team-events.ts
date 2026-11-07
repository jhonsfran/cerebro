import { Schema } from "effect";

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
export const TeamReportTransportSchema = Schema.Union([
  TeamReportDeliverySchema,
  TeamEventReturnSchema,
]);
export type TeamReportTransportMessage = typeof TeamReportTransportSchema.Type;
export const normalizeTeamReport = (input: unknown) => {
  const wire = Schema.decodeUnknownSync(TeamReportTransportSchema, {
    onExcessProperty: "error",
  })(input);
  return "kind" in wire
    ? {
        kind: "event-return" as const,
        wire,
        key: wire.work.key,
        sourceEventAddress: wire.work.sourceEventAddress,
        path: "/team-event-return" as const,
      }
    : {
        kind: "report" as const,
        wire,
        key: wire.report.key,
        sourceEventAddress: wire.sourceEventAddress,
        path: "/team-report" as const,
      };
};
export const teamReportReceiptMatches = (
  delivery: ReturnType<typeof normalizeTeamReport>,
  input: unknown
): boolean => {
  if (delivery.kind === "report") {
    const receipt = Schema.decodeUnknownSync(TeamReportReceiptSchema, {
      onExcessProperty: "error",
    })(input);
    return (
      receipt.reportId === delivery.wire.report.id &&
      canonicalToolArguments(receipt.key) ===
        canonicalToolArguments(delivery.key)
    );
  }
  const receipt = Schema.decodeUnknownSync(TeamEventReturnReceiptSchema, {
    onExcessProperty: "error",
  })(input);
  return (
    receipt.eventId === delivery.wire.eventId &&
    canonicalToolArguments(receipt.key) === canonicalToolArguments(delivery.key)
  );
};
