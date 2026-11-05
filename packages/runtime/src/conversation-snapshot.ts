import type {
  ChatActivity,
  ChatSnapshot,
} from "@cerebro/contracts/session-service";
import { isInternalToolName } from "@cerebro/tools/tool-names";
import { LiveDoc } from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationView,
  Harness,
} from "@earendil-works/pi-durable";

import type { ConversationProfile } from "./conversation-profile.ts";
import type { CoordinatorEvents } from "./coordinator-events.ts";
import { chatSnapshot, piContext, snapshotToolIds } from "./pi-harness.ts";

export const conversationSnapshot = async (
  options: {
    readonly pi: Harness;
    readonly native: Conversation;
    readonly events: CoordinatorEvents;
  },
  view: ConversationView,
  profile: ConversationProfile
): Promise<ChatSnapshot> => {
  const { runtime, work, reminders: schedules, coordination } = profile;
  const { pi, native, events } = options;
  const approvals = await pi.commit(() => runtime.approvals.all(), piContext());
  const [children, known, reminders, inspection, live, backgroundWork] =
    await Promise.all([
      work.children(),
      work.known(),
      schedules.list(),
      pi.inspect(piContext()),
      pi.snapshot(LiveDoc, native.id, piContext()),
      coordination.current(),
    ]);
  const childrenByNativeId = new Map(
    known.map((child) => [child.nativeId, child])
  );
  const activity: ChatActivity = {
    ...(backgroundWork ? { backgroundWork } : {}),
    children,
    reminders,
    compactions: (live?.compactions ?? []).map((compaction) => ({
      id: String(compaction.taskId),
      reason: compaction.reason,
      attempt: compaction.attempt,
      blocking: compaction.blocking,
      ...(compaction.retry ? { retryAt: compaction.retry.at } : {}),
    })),
    ...(live?.compactionFailure
      ? {
          compactionFailure:
            "Context compaction failed. Try again after checking model access.",
        }
      : {}),
    ...(runtime.configuration.origin
      ? {
          origin: {
            conversationId: runtime.configuration.origin.address.conversationId,
            entryId: runtime.configuration.origin.entryId,
          },
        }
      : {}),
    tasks: inspection.tasks
      .filter(
        ({ record }) =>
          record.conversationId === native.id ||
          childrenByNativeId.has(record.conversationId)
      )
      .map(({ record }) => {
        const child = childrenByNativeId.get(record.conversationId);
        const ownerTaskId = record.owner ?? child?.ownerTaskId;
        return {
          id: String(record.id),
          conversationId:
            child?.id ?? runtime.configuration.address.conversationId,
          kind: record.kind,
          background: record.background === true,
          ...(ownerTaskId === undefined
            ? {}
            : { ownerTaskId: String(ownerTaskId) }),
          state:
            record.state.status === "terminal"
              ? "completing"
              : record.state.status,
        };
      }),
  };
  const snapshot = chatSnapshot({
    address: runtime.configuration.address,
    agentVersion: runtime.configuration.agent.version,
    approvals,
    view,
  });
  const visibleOperations = new Set([
    ...snapshot.messages.map((message) => message.operationId),
    ...snapshot.queuedInputs.map((input) => input.operationId),
  ]);
  const pendingInputs = await events.pendingWeb(native.id);
  const pending = pendingInputs.filter(
    (input) => !visibleOperations.has(input.operationId)
  );
  return {
    ...snapshot,
    queuedInputs: [...snapshot.queuedInputs, ...pending],
    activity,
    busy:
      snapshot.busy ||
      pending.length > 0 ||
      activity.compactions.some((compaction) => compaction.reason === "manual"),
  };
};
export const snapshotAccessTools = async (
  snapshot: ChatSnapshot,
  profile: ConversationProfile
): Promise<readonly string[]> =>
  [
    ...new Set([
      ...snapshotToolIds(snapshot),
      ...(await profile.work.toolIds()),
    ]),
  ].filter((name) => !isInternalToolName(name));
