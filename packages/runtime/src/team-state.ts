import { Conflict, Denied } from "@cerebro/contracts/failures";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import {
  BoundedContentDependenciesSchema,
  WorkAdmissionSchema,
} from "@cerebro/contracts/work";
import type {
  TeamCommand,
  WorkAdmission,
  WorkReport,
} from "@cerebro/contracts/work";
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  JsonObject,
  TaskId,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

export interface TeamChild extends JsonObject {
  nativeId: ConversationId;
  ownerTaskId: TaskId;
  startedAt: number;
}
export interface TeamStateValue extends JsonObject {
  admission: WorkAdmission | null;
  phase: "waiting" | "running" | "cancelled" | "completed" | "failed";
  modelCalls: number;
  lead: ConversationId | null;
  children: Record<string, TeamChild>;
  requests: string[];
  pending: Record<string, TaskId>;
  inputCount: number;
  report: WorkReport | null;
}
export const TeamState = defineDoc({
  kind: "cerebro.team",
  scope: "session",
  version: 2,
  initial: (): TeamStateValue => ({
    admission: null,
    phase: "waiting",
    modelCalls: 0,
    lead: null,
    children: {},
    requests: [],
    pending: {},
    inputCount: 0,
    report: null,
  }),
});
export const workerRequestId = (ownerTaskId: TaskId): string =>
  `worker:${ownerTaskId}`;
export const teamChildren = (state: TeamStateValue) =>
  Object.entries(state.children)
    .map(([index, child]) => ({ ...child, index: Number(index) }))
    .toSorted((left, right) => left.index - right.index);
export const teamRoleConversation = (
  state: TeamStateValue,
  index: number
): ConversationId | undefined =>
  (index === 0 ? state.lead : state.children[String(index)]?.nativeId) ??
  undefined;
export const teamConversationIds = (
  state: TeamStateValue | undefined
): ConversationId[] =>
  state?.lead
    ? [state.lead, ...teamChildren(state).map((child) => child.nativeId)]
    : [];
export const TeamCommandReceipts = defineDocFamily({
  kind: "cerebro.team-command",
  scope: "session",
  family: true,
  version: 1,
  initial: (
    _seed: null
  ): {
    receipt: {
      digest: string;
      taskId: TaskId | null;
      accepted: boolean;
      reason: string | null;
    } | null;
  } => ({ receipt: null }),
});
export const requireTeamAdmission = (
  state: TeamStateValue,
  admission: WorkAdmission
): void => {
  const decoded = Schema.decodeUnknownSync(WorkAdmissionSchema, {
    onExcessProperty: "error",
  })(admission);
  const saved = state.admission
    ? Schema.decodeUnknownSync(WorkAdmissionSchema, {
        onExcessProperty: "error",
      })(state.admission)
    : null;
  if (
    saved &&
    canonicalToolArguments(saved) !== canonicalToolArguments(decoded)
  ) {
    throw new Conflict({
      code: "digest-mismatch",
      reason: "The immutable team admission changed.",
    });
  }
  if (!state.admission) {
    state.admission = decoded;
  }
};
export const requireTeamRunning = (
  state: TeamStateValue,
  now: number
): WorkAdmission => {
  if (
    !state.admission ||
    state.phase !== "running" ||
    state.admission.deadlineAt <= now
  ) {
    throw new Denied({
      code: "revoked",
      reason: "The team work is no longer running.",
    });
  }
  return Schema.decodeUnknownSync(WorkAdmissionSchema, {
    onExcessProperty: "error",
  })(state.admission);
};
export const teamInputRejection = (
  state: TeamStateValue | null | undefined,
  work: WorkAdmission,
  now: number
): "cancelled" | "terminal" | "expired" | null => {
  if (state?.phase === "cancelled") {
    return "cancelled";
  }
  if (
    state?.report ||
    state?.phase === "completed" ||
    state?.phase === "failed"
  ) {
    return "terminal";
  }
  if (work.deadlineAt <= now) {
    return "expired";
  }
  return null;
};
export const teamCommandDependencies = (command: TeamCommand) =>
  Schema.decodeUnknownSync(BoundedContentDependenciesSchema)({
    sourceIds: [
      ...new Set([
        ...command.work.contentDependencies.sourceIds,
        ...(command.kind === "input"
          ? command.contentDependencies.sourceIds
          : []),
      ]),
    ],
    toolIds: [
      ...new Set([
        ...command.work.contentDependencies.toolIds,
        ...(command.kind === "input"
          ? command.contentDependencies.toolIds
          : []),
      ]),
    ],
  });
