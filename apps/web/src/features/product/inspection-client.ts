import type { EventAddress } from "@cerebro/contracts/events";
import { InspectionFrame } from "@cerebro/contracts/inspection";
import type { InspectionQuery } from "@cerebro/contracts/inspection";
import type { ChatSnapshot } from "@cerebro/contracts/session-service";
import { Schema } from "effect";
import { z } from "zod";

import { request } from "./api";

export type InspectionOverview = Extract<InspectionFrame, { kind: "overview" }>;
export type InspectionHistory = Extract<InspectionFrame, { kind: "history" }>;
export type InspectionEvents = Extract<InspectionFrame, { kind: "events" }>;
export type InspectionTeamFrame = Extract<InspectionFrame, { kind: "team" }>;
export type InspectionTasks = Extract<InspectionFrame, { kind: "tasks" }>;
export type InspectionTranscript = Extract<
  InspectionFrame,
  { kind: "transcript" }
>;
export type InspectionRolePage = InspectionTasks | InspectionTranscript;

const frameSchema = z
  .unknown()
  .transform((input) =>
    Schema.decodeUnknownSync(InspectionFrame, { onExcessProperty: "error" })(
      input
    )
  );

export const sameInspectionSource = (
  left: EventAddress,
  right: EventAddress
): boolean =>
  left.organizationId === right.organizationId &&
  left.agentId === right.agentId &&
  left.conversationId === right.conversationId &&
  left.sessionId === right.sessionId;

export const readInspection = async (
  path: string,
  address: EventAddress,
  query: InspectionQuery,
  signal: AbortSignal
): Promise<InspectionFrame> => {
  const frame = await request(`${path}/inspection`, frameSchema, {
    body: JSON.stringify({ query }),
    method: "POST",
    signal,
  });
  if (
    frame.kind !== query.kind ||
    !sameInspectionSource(frame.address, address)
  ) {
    throw new Error("The inspection response changed its source.");
  }
  if ("workId" in query) {
    let workId: string | null = null;
    if (frame.kind === "team") {
      ({ workId } = frame.work);
    } else if ("workId" in frame) {
      ({ workId } = frame);
    }
    if (workId !== query.workId) {
      throw new Error("The inspection response changed its work.");
    }
  }
  if ("role" in query && (!("role" in frame) || frame.role !== query.role)) {
    throw new Error("The inspection response changed its role.");
  }
  return frame;
};

export const completedInspectionSignal = (
  messages: ChatSnapshot["messages"]
): string | null => {
  let completed: string | null = null;
  for (const message of messages) {
    if (
      message.role === "assistant" &&
      message.state === "complete" &&
      message.kind !== "summary" &&
      message.outcome !== "tool-call"
    ) {
      completed = message.id;
    }
  }
  return completed;
};

const inspectionDateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
export const inspectionTime = (value: number | null): string =>
  value === null ? "Not recorded" : inspectionDateTime.format(value);
