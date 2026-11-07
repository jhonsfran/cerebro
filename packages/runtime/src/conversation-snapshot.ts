import type {
  ChatActivity,
  ChatSnapshot,
} from "@cerebro/contracts/session-service";
import { LiveDoc } from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationView,
  Harness,
} from "@earendil-works/pi-durable";

import type { ConversationProfile } from "./conversation-profile.ts";
import type { CoordinatorEvents } from "./coordinator-events.ts";
import { chatSnapshot, piContext } from "./pi-harness.ts";

export const conversationSnapshot = async (
  options: {
    readonly pi: Harness;
    readonly native: Conversation;
    readonly events: CoordinatorEvents;
  },
  view: ConversationView,
  profile: ConversationProfile
): Promise<ChatSnapshot> => {
  const { runtime, reminders: schedules, coordination } = profile;
  const { pi, native, events } = options;
  const approvals = await pi.commit(() => runtime.approvals.all(), piContext());
  const [reminders, inspection, live, backgroundWork] = await Promise.all([
    schedules.list(),
    pi.inspect(piContext()),
    pi.snapshot(LiveDoc, native.id, piContext()),
    coordination.current(),
  ]);
  const activity: ChatActivity = {
    ...(backgroundWork ? { backgroundWork } : {}),
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
    tasks: inspection.tasks
      .filter(({ record }) => record.conversationId === native.id)
      .map(({ record }) => ({
        id: String(record.id),
        conversationId: runtime.configuration.address.conversationId,
        kind: record.kind,
        background: record.background === true,
        ...(record.owner === undefined
          ? {}
          : { ownerTaskId: String(record.owner) }),
        state:
          record.state.status === "terminal"
            ? "completing"
            : record.state.status,
      })),
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
