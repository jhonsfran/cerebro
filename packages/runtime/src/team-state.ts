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

export interface TeamWorker extends JsonObject {
  nativeId: ConversationId;
  ownerTaskId: TaskId | null;
  digest: string | null;
  requestId: string | null;
  inputDependencies: WorkAdmission["contentDependencies"] | null;
}
export interface TeamStateValue extends JsonObject {
  admission: WorkAdmission | null;
  phase: "waiting" | "running" | "cancelled" | "completed" | "failed";
  modelCalls: number;
  lead: ConversationId | null;
  workers: TeamWorker[];
  requests: string[];
  pending: Record<string, TaskId>;
  inputCount: number;
  report: WorkReport | null;
}
export const TeamState = defineDoc({
  kind: "cerebro.team",
  scope: "session",
  version: 1,
  initial: (): TeamStateValue => ({
    admission: null,
    phase: "waiting",
    modelCalls: 0,
    lead: null,
    workers: [],
    requests: [],
    pending: {},
    inputCount: 0,
    report: null,
  }),
});
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
  if (
    state.admission &&
    canonicalToolArguments(state.admission) !==
      canonicalToolArguments(admission)
  ) {
    throw new Conflict({
      code: "digest-mismatch",
      reason: "The immutable team admission changed.",
    });
  }
  if (!state.admission) {
    state.admission = Schema.decodeUnknownSync(WorkAdmissionSchema)(admission);
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
  return state.admission;
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
