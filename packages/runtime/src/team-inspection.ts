import { Denied, NotFound } from "@cerebro/contracts/failures";
import { INSPECTION_PAGE_SIZE } from "@cerebro/contracts/inspection";
import type {
  TeamInspectionQuery,
  InspectionRole,
  TeamInspectionFrame,
} from "@cerebro/contracts/inspection";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import { workCellName } from "@cerebro/contracts/work";
import type { WorkAdmission } from "@cerebro/contracts/work";
import {
  AgentDoc,
  InboxDoc,
  LiveDoc,
  UsageDoc,
} from "@earendil-works/pi-durable";
import type {
  Harness,
  ConversationId,
  LiveState,
} from "@earendil-works/pi-durable";

import {
  inspectEntries,
  inspectLive,
  inspectTask,
  inspectUsage,
} from "./inspection-native.ts";
import { inspectionCursor, nextInspectionCursor } from "./inspection-page.ts";
import { inspectionResult } from "./inspection-work.ts";
import { piContext } from "./pi-harness.ts";
import { teamRoleKind } from "./team-composition.ts";
import {
  TeamState,
  teamChildren,
  teamConversationIds,
  teamRoleConversation,
  workerRequestId,
} from "./team-state.ts";
import type { TeamChild, TeamStateValue } from "./team-state.ts";

interface TeamRead {
  readonly pi: Harness;
  readonly work: WorkAdmission;
  readonly signal?: AbortSignal;
}
const roleProgress = (
  live: LiveState | undefined,
  child: TeamChild | undefined
) => ({
  running: live?.run !== undefined,
  ownerTaskId: child ? String(child.ownerTaskId) : null,
  requestId: child ? workerRequestId(child.ownerTaskId) : null,
  startedAt: child?.startedAt ?? null,
  attempt: live?.generation?.attempt ?? null,
  retryAt:
    live?.generation?.retry?.at ?? live?.generation?.deferred?.pollAt ?? null,
});
const readRole = async (
  input: TeamRead,
  nativeId: ConversationId,
  slot: number,
  child?: TeamChild
): Promise<InspectionRole> => {
  const context = piContext(input.signal);
  const [agent, live, usage] = await Promise.all([
    input.pi.snapshot(AgentDoc, nativeId, context),
    input.pi.snapshot(LiveDoc, nativeId, context),
    input.pi.snapshot(UsageDoc, nativeId, context),
  ]);
  return {
    slot,
    nativeId: String(nativeId),
    definition: input.work.agent,
    role: teamRoleKind(input.work, slot),
    modelId: agent?.model?.modelId ?? null,
    ...roleProgress(live, child),
    usage: inspectUsage(usage?.models),
    toolUsage: inspectUsage(usage?.tools),
  };
};
const readSummary = async (
  input: TeamRead,
  state: TeamStateValue
): Promise<TeamInspectionFrame> => {
  const context = piContext(input.signal);
  const ids = teamConversationIds(state);
  const candidates = state.lead
    ? await Promise.all([
        readRole(input, state.lead, 0),
        ...teamChildren(state).map((child) =>
          readRole(input, child.nativeId, child.index, child)
        ),
      ])
    : [];
  const inspection = await input.pi.inspect(context);
  const inboxes = await Promise.all(
    ids.map((nativeId) => input.pi.snapshot(InboxDoc, nativeId, context))
  );
  const sealed =
    state.report !== null &&
    !inspection.tasks.some(({ record }) =>
      ids.includes(record.conversationId)
    ) &&
    candidates.every((role) => !role.running) &&
    inboxes.every((inbox) => (inbox?.items.length ?? 0) === 0) &&
    Object.keys(state.pending).length === 0;
  return {
    kind: "team",
    workId: input.work.key.workId,
    team: {
      kind: "available",
      cell: workCellName(input.work.key),
      phase: state.phase,
      sealed,
      requestReservations: state.modelCalls,
      requestLimit: input.work.limits.maxTurns,
      roles: candidates,
      result: inspectionResult(state.report),
      monetaryCost: "unavailable",
    },
  };
};
const readTranscript = async (
  input: TeamRead,
  nativeId: ConversationId,
  query: Extract<TeamInspectionQuery, { kind: "transcript" }>
): Promise<TeamInspectionFrame> => {
  const context = piContext(input.signal);
  const native = await input.pi.conversation(nativeId, context);
  if (!native) {
    throw new NotFound({ resource: "Private role conversation" });
  }
  const page = await native.entries(
    { order: "descending" },
    INSPECTION_PAGE_SIZE,
    inspectionCursor(input.work.sourceEventAddress, query),
    context
  );
  const projected = inspectEntries(page.items.toReversed());
  const live = query.cursor
    ? undefined
    : await input.pi.snapshot(LiveDoc, nativeId, context);
  const task =
    live?.run && live.tools?.some((tool) => tool.status !== "done")
      ? await input.pi.getTask(live.run.taskId, context)
      : undefined;
  return {
    kind: "transcript",
    workId: input.work.key.workId,
    role: query.role,
    ...inspectLive(projected, live, { task, conversationId: nativeId }),
    next: nextInspectionCursor(input.work.sourceEventAddress, query, page.next),
  };
};
export const readTeamInspection = async (
  input: TeamRead & { readonly query: TeamInspectionQuery }
): Promise<TeamInspectionFrame> => {
  const { pi, work, query, signal } = input;
  const state = await pi.snapshot(TeamState, piContext(signal));
  if (
    !state?.admission ||
    canonicalToolArguments(state.admission) !== canonicalToolArguments(work)
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "The private work admission does not match.",
    });
  }
  if (query.kind === "team") {
    return await readSummary(input, state);
  }
  const nativeId = teamRoleConversation(state, query.role);
  if (!nativeId) {
    throw new NotFound({ resource: "Private role conversation" });
  }
  if (query.kind === "transcript") {
    return await readTranscript(input, nativeId, query);
  }
  const page = await pi.commit(
    (tx) =>
      tx.scanTasks(
        { conversationId: nativeId, order: "descending" },
        INSPECTION_PAGE_SIZE,
        inspectionCursor(work.sourceEventAddress, query)
      ),
    piContext(signal)
  );
  return {
    kind: "tasks",
    workId: work.key.workId,
    role: query.role,
    tasks: page.items.map(inspectTask),
    next: nextInspectionCursor(work.sourceEventAddress, query, page.next),
  };
};
