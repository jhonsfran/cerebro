import { createHash } from "node:crypto";

import { Schema } from "effect";
import { z } from "zod";

import {
  BotEventSchema,
  botEventId,
} from "../../../packages/contracts/src/bot-events.ts";
import type { EventAddress } from "../../../packages/contracts/src/events.ts";
import {
  normalizeTeamReport,
  normalizeTeamCommand,
} from "../../../packages/contracts/src/team-events.ts";
import { canonicalToolArguments } from "../../../packages/contracts/src/tools.ts";
import type {
  WorkKey,
  TeamReportDelivery,
} from "../../../packages/contracts/src/work.ts";
import { botEventInput } from "../../../packages/runtime/src/coordinator-event-input.ts";
import { authorizedPilotInput } from "../../slice-1/application.ts";

export interface WorkTarget {
  key: WorkKey;
  sourceEventAddress: EventAddress;
}
export const queueBodies = (value: unknown): unknown[] =>
  z
    .object({
      messages: z.array(
        z.object({ bodyBase64: z.string(), contentType: z.literal("json") })
      ),
    })
    .parse(value)
    .messages.map((message) =>
      JSON.parse(Buffer.from(message.bodyBase64, "base64").toString("utf-8"))
    );
const matchesWork = (
  actual: ReturnType<typeof normalizeTeamReport>,
  target: WorkTarget
) =>
  canonicalToolArguments(actual.key) === canonicalToolArguments(target.key) &&
  canonicalToolArguments(actual.sourceEventAddress) ===
    canonicalToolArguments(target.sourceEventAddress);
export const matchingWorkReport = (
  value: unknown,
  target: WorkTarget,
  reportId?: string
) =>
  queueBodies(value)
    .map(normalizeTeamReport)
    .find(
      (delivery) =>
        delivery.kind === "report" &&
        matchesWork(delivery, target) &&
        (reportId === undefined || delivery.wire.report.id === reportId)
    );
export const matchingEventReturn = (
  value: unknown,
  target: WorkTarget,
  event: { id: string; digest: string }
) =>
  queueBodies(value)
    .map(normalizeTeamReport)
    .find(
      (delivery) =>
        delivery.kind === "event-return" &&
        matchesWork(delivery, target) &&
        delivery.wire.eventId === event.id &&
        delivery.wire.eventDigest === event.digest
    );
export const matchingTeamEvent = (
  value: unknown,
  target: WorkTarget,
  externalEventId: string
) =>
  queueBodies(value)
    .map(normalizeTeamCommand)
    .find(
      (delivery) =>
        delivery.event?.source.kind === "slack" &&
        delivery.event.source.eventId === externalEventId &&
        canonicalToolArguments(delivery.command.work.key) ===
          canonicalToolArguments(target.key) &&
        canonicalToolArguments(delivery.command.work.sourceEventAddress) ===
          canonicalToolArguments(target.sourceEventAddress)
    );
export const reportEvent = async (delivery: TeamReportDelivery) => {
  const { report } = delivery;
  const source = {
    kind: "teamreport" as const,
    key: report.key,
    reportId: report.id,
    outcome: report.kind,
  };
  let text = "Team work cancelled.";
  if (report.kind === "completed") {
    ({ text } = report);
  }
  if (report.kind === "failed") {
    text = report.reason;
  }
  return Schema.decodeUnknownSync(BotEventSchema)({
    version: 1,
    id: await botEventId(delivery.sourceEventAddress, source),
    coordinator: delivery.sourceEventAddress,
    ownerPrincipalId: report.key.ownerPrincipalId,
    source,
    replyTo: null,
    content: {
      text: text.slice(0, 2000),
      reference: { kind: "work", key: report.key },
    },
    dependencies: report.contentDependencies,
  });
};
export const reportInputDigest = async (
  delivery: TeamReportDelivery,
  sourceContext: "none" | "pilot" = "none"
) => {
  const text = botEventInput(await reportEvent(delivery));
  return createHash("sha256")
    .update(sourceContext === "pilot" ? authorizedPilotInput(text) : text)
    .digest("hex");
};
