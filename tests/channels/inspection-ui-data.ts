import { Schema } from "effect";

import {
  InspectionRole,
  InspectionWork,
} from "../../packages/contracts/src/inspection.ts";
import type {
  InspectionFrame,
  InspectionTeam,
} from "../../packages/contracts/src/inspection.ts";
import { ChatSnapshot } from "../../packages/contracts/src/session-service.ts";
import { EventAddressSchema } from "../../packages/contracts/src/work.ts";

export const inspectionAddress = Schema.decodeUnknownSync(EventAddressSchema)({
  organizationId: "company",
  agentId: "agent",
  conversationId: "conversation",
  sessionId: "session",
});
export const inspectionProfile = { agentVersion: 2 } as const;
export const inspectionWork = (
  workId = "work-a",
  changes: Partial<InspectionWork> = {}
): InspectionWork =>
  Schema.decodeUnknownSync(InspectionWork)({
    workId,
    goal: { text: `Goal ${workId}`, truncated: false },
    status: "completed",
    admittedAt: 1_800_000_000_000,
    deadlineAt: 1_800_000_060_000,
    dispatched: true,
    reservationHeld: false,
    result: null,
    subscriptions: [],
    ...changes,
  });
const tokens = {
  input: 101,
  output: 37,
  cacheRead: 11,
  cacheWrite: 7,
  totalTokens: 156,
};
export const inspectionRole = (slot: InspectionRole["slot"]): InspectionRole =>
  Schema.decodeUnknownSync(InspectionRole)({
    slot,
    nativeId: `native-${slot}`,
    definition: { agentId: "team-agent", agentVersion: 3 },
    role: slot === 0 ? "lead" : "worker",
    modelId: "agent-model",
    running: false,
    ownerTaskId: slot === 0 ? null : `owner-${slot}`,
    requestId: slot === 0 ? null : `request-${slot}`,
    usage: tokens,
    toolUsage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    },
    attempt: 2,
    retryAt: null,
  });
export const inspectionOverview = (
  work: readonly InspectionWork[] = [],
  refresh = false
): Extract<InspectionFrame, { kind: "overview" }> => ({
  kind: "overview",
  address: inspectionAddress,
  profile: inspectionProfile,
  work,
  refresh,
});
export const inspectionTeam = (
  work = inspectionWork(),
  changes: Partial<Extract<InspectionTeam, { kind: "available" }>> = {}
): Extract<InspectionFrame, { kind: "team" }> => ({
  kind: "team",
  address: inspectionAddress,
  profile: inspectionProfile,
  work,
  team: {
    kind: "available",
    cell: `private-cell:${work.workId}`,
    phase: "completed",
    sealed: true,
    requestReservations: 8,
    requestLimit: 20,
    roles: [inspectionRole(0), inspectionRole(1), inspectionRole(2)],
    monetaryCost: "unavailable",
    result: {
      id: `result:${work.workId}`,
      kind: "completed",
      content: { text: `Saved result ${work.workId}`, truncated: true },
    },
    ...changes,
  },
});
export const inspectionTranscript = (
  workId = inspectionWork().workId,
  role: InspectionRole["slot"] = 0
): Extract<InspectionFrame, { kind: "transcript" }> => ({
  kind: "transcript",
  address: inspectionAddress,
  profile: inspectionProfile,
  workId,
  role,
  next: "older-transcript",
  messages: [
    {
      id: "message-a",
      entryId: "entry-a",
      role: "user",
      content: { text: "Compare SQLite and PostgreSQL.", truncated: false },
      modelId: null,
      timestamp: 1_800_000_000_001,
      state: "complete",
    },
    {
      id: "message-b",
      entryId: "entry-b",
      role: "assistant",
      content: { text: "SQLite fits this local workflow.", truncated: false },
      modelId: "saved-answer-model",
      timestamp: 1_800_000_000_002,
      state: "complete",
    },
  ],
  tools: [
    {
      id: "tool-call-a",
      callId: "provider-call-a",
      name: "delegate_worker",
      status: "succeeded",
      input: {
        kind: "text",
        label: "Delegation",
        content: { text: "Check database recovery.", truncated: false },
      },
      output: { text: "WAL preserves committed writes.", truncated: false },
      resultEntryId: "tool-result-a",
    },
    {
      id: "tool-call-b",
      callId: "provider-call-b",
      name: "unknown_connector",
      status: "failed",
      input: { kind: "unavailable" },
      output: null,
      resultEntryId: "tool-result-b",
    },
  ],
});
export const inspectionTasks = (
  workId = inspectionWork().workId,
  role: InspectionRole["slot"] = 0
): Extract<InspectionFrame, { kind: "tasks" }> => ({
  kind: "tasks",
  address: inspectionAddress,
  profile: inspectionProfile,
  workId,
  role,
  next: null,
  tasks: [
    {
      id: "task-a",
      kind: "pi.generation",
      version: 1,
      ownerTaskId: "owner-task",
      background: true,
      abortRequested: false,
      status: "terminal",
      outcome: "completed",
      phase: "send",
      attempt: 2,
      retryAt: 1_800_000_001_000,
      startedAt: 1_800_000_000_000,
      endedAt: 1_800_000_003_000,
    },
  ],
});
export const inspectionSnapshot = (
  changes: Partial<ChatSnapshot> = {}
): ChatSnapshot =>
  Schema.decodeUnknownSync(ChatSnapshot)({
    address: inspectionAddress,
    agentVersion: 2,
    approvals: [],
    tools: [],
    messages: [],
    queuedInputs: [],
    busy: false,
    activity: { compactions: [], reminders: [], tasks: [] },
    ...changes,
  });
