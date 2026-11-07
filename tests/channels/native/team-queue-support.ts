import { createHash } from "node:crypto";

import { Schema } from "effect";
import { z } from "zod";

import type { EventAddress } from "../../../packages/contracts/src/events.ts";
import {
  normalizeTeamReport,
  normalizeTeamCommand,
} from "../../../packages/contracts/src/team-events.ts";
import { canonicalToolArguments } from "../../../packages/contracts/src/tools.ts";
import {
  TriggerSchema,
  inputText,
  triggerId,
} from "../../../packages/contracts/src/triggers.ts";
import type {
  WorkKey,
  TeamReportDelivery,
} from "../../../packages/contracts/src/work.ts";
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
        delivery.event?.origin.kind === "slack" &&
        delivery.event.origin.eventId === externalEventId &&
        canonicalToolArguments(delivery.command.work.key) ===
          canonicalToolArguments(target.key) &&
        canonicalToolArguments(delivery.command.work.sourceEventAddress) ===
          canonicalToolArguments(target.sourceEventAddress)
    );
export const reportEvent = async (delivery: TeamReportDelivery) => {
  const { report } = delivery;
  const origin = {
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
  return Schema.decodeUnknownSync(TriggerSchema)({
    version: 2,
    id: await triggerId(delivery.sourceEventAddress, origin),
    address: delivery.sourceEventAddress,
    ownerPrincipalId: report.key.ownerPrincipalId,
    origin,
    text: text.slice(0, 2000),
    reference: { kind: "work", key: report.key },
    reply: null,
    dependencies: report.contentDependencies,
  });
};
export const reportInputDigest = async (
  delivery: TeamReportDelivery,
  sourceContext: "none" | "pilot" = "none"
) => {
  const text = inputText(await reportEvent(delivery));
  return createHash("sha256")
    .update(sourceContext === "pilot" ? authorizedPilotInput(text) : text)
    .digest("hex");
};
