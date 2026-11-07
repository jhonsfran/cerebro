import type { ContractFailure } from "@cerebro/contracts/failures";
import type { Conversation, Extension, Tx } from "@earendil-works/pi-durable";
import { Effect, Result } from "effect";

import type { createApprovalStore } from "./approval-store.ts";
import { companySkillsExtension } from "./company-skills.ts";
import { profileKey } from "./conversation-bindings.ts";
import type { ProfileIdentity } from "./conversation-bindings.ts";
import { createConversationCompaction } from "./conversation-compaction.ts";
import { conversationProvider } from "./conversation-provider.ts";
import type { createReminderSerialization } from "./conversation-reminders.ts";
import { createConversationReminders } from "./conversation-reminders.ts";
import { createConversationResources } from "./conversation-resources.ts";
import type { ConversationScopeServices } from "./conversation-scope.ts";
import { createCoordinatorApprovals } from "./coordinator-approvals.ts";
import { terminalNoticeIn } from "./coordinator-event-content.ts";
import { createCoordinatorReport } from "./coordinator-report.ts";
import { createCoordinatorSubscriptions } from "./coordinator-subscriptions.ts";
import { createCoordinatorWeb } from "./coordinator-web.ts";
import { createCoordinatorWork } from "./coordinator-work.ts";
import { createGenerativeUiTool } from "./generative-ui-tool.ts";
import { prepareInstructionCause } from "./instruction-cause.ts";
import {
  createReplyNudge,
  createReplyTool,
  profileReplyScope,
} from "./replies.ts";
import { createRunLimits } from "./run-limits.ts";
import { saveReminderOriginIn } from "./saved-timer-state.ts";
import type { SavedTimerOccurrence } from "./saved-timer-state.ts";
import type { SessionHostConfiguration } from "./session-agent.ts";

const run = async <A>(
  program: Effect.Effect<A, ContractFailure>
): Promise<A> => {
  const result = await Effect.runPromise(Effect.result(program));
  if (Result.isFailure(result)) {
    throw result.failure;
  }
  return result.success;
};
export const profileInstructions = (
  configuration: SessionHostConfiguration
): string =>
  `${configuration.agent.instructions}\nHandle conversation and coordinate independent work. Use start_team for each independent task when available. Keep Team histories private and recall bounded results when needed. An event that names an eventId arrived from an external channel; answer it with reply_event when a reply is wanted. Web messages need no reply_event. When a Team asks for approval, tell the person to Allow or Deny it in web chat; you cannot decide it.`;

export interface ProfileState {
  readonly approvals: ReturnType<typeof createApprovalStore>;
  readonly serialize: ReturnType<typeof createReminderSerialization>;
  coordination?: Pick<
    ReturnType<typeof createCoordinatorWork>,
    "admissions" | "dispatch"
  >;
  readonly guardIn: (identity: ProfileIdentity) => (tx: Tx) => Promise<void>;
  readonly requireCurrent: (identity: ProfileIdentity) => void;
  readonly nativeGuardIn: (
    identity: ProfileIdentity
  ) => (tx: Tx) => Promise<void>;
  readonly submit: (text: string, operationId: string) => Promise<unknown>;
  readonly submitOccurrence: (
    occurrence: SavedTimerOccurrence
  ) => Promise<void>;
  readonly dispatchAccess: NonNullable<
    Parameters<typeof createCoordinatorWork>[0]["dispatchAccess"]
  >;
}
export const createConversationProfile = async (
  configuration: SessionHostConfiguration,
  services: ConversationScopeServices,
  native: Conversation,
  shared: ProfileState,
  identity: ProfileIdentity
) => {
  const runtime = createConversationResources(
    configuration,
    services.storage,
    services.metadata,
    {
      approvals: shared.approvals,
      guardIn: shared.guardIn(identity),
      requireCurrent: () => shared.requireCurrent(identity),
    }
  );
  const identityOwner = await run(configuration.ownerContext());
  const ownerPrincipalId =
    identityOwner.represented?.id ?? identityOwner.actor.id;
  const authorize = async (signal?: AbortSignal) => {
    const owner = await run(configuration.ownerContext());
    await runtime.authorize(owner, "send", signal);
  };
  const reminders = createConversationReminders({
    serialize: shared.serialize,
    guardIn: runtime.guardIn,
    saveOriginIn: (tx, reminderId, cause) =>
      saveReminderOriginIn(tx, {
        nativeId: native.id,
        reminderId,
        address: configuration.address,
        ownerPrincipalId,
        cause,
      }),
    prepareScheduleCause: async () => {
      const owner = await run(configuration.ownerContext());
      return await prepareInstructionCause({
        pi: services.pi,
        nativeId: native.id,
        address: configuration.address,
        ownerPrincipalId: owner.represented?.id ?? owner.actor.id,
      });
    },
    authorize,
    authorizeDelivery: async () =>
      runtime.authorize(await run(configuration.ownerContext()), "transfer"),
    submitOccurrence: shared.submitOccurrence,
    authorizeCancel: async () =>
      runtime.authorize(await run(configuration.ownerContext()), "stop"),
    jobs: services.jobs,
    metadata: services.metadata,
    nativeId: native.id,
    persist: () => services.storage.sync(),
    pi: services.pi,
    sessionId: configuration.address.sessionId,
    submit: (text, operationId) => shared.submit(text, operationId),
  });
  const compaction = createConversationCompaction({
    guardIn: shared.nativeGuardIn(identity),
    authorize,
    jobs: services.jobs,
    nativeId: native.id,
    persist: () => services.storage.sync(),
    pi: services.pi,
    sessionId: configuration.address.sessionId,
    waitUntil: services.waitUntil,
  });
  const coordination = createCoordinatorWork({
    guardIn: runtime.guardIn,
    shared: shared.coordination,
    dispatchAccess: shared.dispatchAccess,
    terminalNoticeIn: terminalNoticeIn(services.triggers),
    returnEventIn: services.triggers.returnEventIn,
    address: configuration.address,
    authorize: async (signal) =>
      runtime.authorize(
        await run(configuration.ownerContext()),
        "coordinate",
        signal
      ),
    jobs: services.jobs,
    metadata: services.metadata,
    nativeId: native.id,
    persist: () => services.storage.sync(),
    pi: services.pi,
    services: configuration.coordination,
    scanWorkKeys: services.scanWorkKeys,
    contentAccess: {
      check: async (dependencies, signal) => {
        const context = await run(configuration.ownerContext());
        await runtime.authorize(context, "transfer", signal);
        await run(
          configuration.checkDependencies(context, dependencies, {
            deadlineAt: Date.now() + 30_000,
            signal,
          })
        );
      },
      retain: (dependencies) =>
        configuration.importDependencies?.(dependencies),
    },
    waitUntil: services.waitUntil,
  });
  const source = {
    pi: services.pi,
    native,
    runtime,
    coordination,
  };
  const replyScope = profileReplyScope({
    runtime,
    requireCurrent: () => shared.requireCurrent(identity),
  });
  const web = createCoordinatorWeb({
    pi: services.pi,
    native,
    runtime,
    triggers: services.triggers,
    replies: services.replies,
    replyScope,
  });
  const receiveReport = createCoordinatorReport({
    ...source,
    persist: () => services.storage.sync(),
    triggers: services.triggers,
    waitUntil: services.waitUntil,
  });
  const teamApprovals = createCoordinatorApprovals({
    ...source,
    persist: () => services.storage.sync(),
    triggers: services.triggers,
    waitUntil: services.waitUntil,
  });
  const subscriptions = createCoordinatorSubscriptions({
    guardIn: runtime.guardIn,
    pi: services.pi,
    nativeId: native.id,
    coordination,
    ownerContext: () => run(runtime.configuration.ownerContext()),
    authorize: (context) => runtime.authorize(context, "coordinate"),
    checkDependencies: async (context, dependencies) => {
      await runtime.authorize(context, "transfer");
      await run(
        runtime.configuration.checkDependencies(context, dependencies, {
          deadlineAt: Date.now() + 30_000,
        })
      );
    },
    readEvent: services.triggers.read,
  });
  shared.coordination ??= {
    admissions: coordination.admissions,
    dispatch: coordination.dispatch,
  };
  const suffix = `:${profileKey(identity)}`;
  const tools: Extension = {
    name: `cerebro-tools:${configuration.address.sessionId}${suffix}`,
    hooks: [
      ...createRunLimits({ pi: services.pi }),
      createReplyNudge({ pi: services.pi, nativeId: native.id }),
    ],
    tools: [
      ...reminders.tools,
      ...coordination.tools,
      ...subscriptions.tools,
      createReplyTool({
        pi: services.pi,
        nativeId: native.id,
        replies: services.replies,
        scope: replyScope,
        contentDependencies: () =>
          configuration.contentDependencies?.() ??
          Promise.resolve({ sourceIds: [], toolIds: [] }),
        guardIn: runtime.guardIn,
      }),
      createGenerativeUiTool({ authorize }),
    ],
  };
  const extensions = [tools];
  if (configuration.skills?.length) {
    extensions.push({
      ...(await companySkillsExtension(configuration.skills)),
      name: `cerebro-skills:${configuration.address.sessionId}${suffix}`,
    });
  }
  const provider = conversationProvider(
    configuration.address.sessionId,
    configuration.provider.model,
    runtime.provider,
    profileKey(identity)
  );
  const registration = {
    extensions,
    provider,
    agent: {
      extensions,
      instructions: profileInstructions(configuration),
      model: {
        modelId: configuration.provider.model.id,
        provider: provider.id,
      },
      tools: null,
      modelTools: null,
    },
  };
  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    runtime,
    reminders,
    compaction,
    coordination,
    receiveReport,
    teamApprovals,
    subscriptions,
    web,
    registration,
  });
};
export type ConversationProfile = Awaited<
  ReturnType<typeof createConversationProfile>
>;
