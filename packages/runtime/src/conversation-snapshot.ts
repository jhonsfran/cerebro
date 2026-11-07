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
import { chatSnapshot, piContext } from "./pi-harness.ts";
import type { Triggers } from "./triggers.ts";

export const conversationSnapshot = async (
  options: {
    readonly pi: Harness;
    readonly native: Conversation;
    readonly triggers: Pick<Triggers, "queuedWeb">;
  },
  view: ConversationView,
  profile: ConversationProfile
): Promise<ChatSnapshot> => {
  const { runtime, reminders: schedules, coordination } = profile;
  const { pi, native, triggers } = options;
  const approvals = [
    ...(await pi.commit(() => runtime.approvals.all(), piContext())),
    ...(await profile.teamApprovals.list()),
  ];
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
  const backlog = await triggers.queuedWeb(native.id);
  const pending = backlog.filter(
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
