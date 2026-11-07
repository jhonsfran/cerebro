/* oxlint-disable no-await-in-loop -- A changed profile requires a new authorization before the next occurrence attempt. */
import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
} from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import { digestToolArguments } from "@cerebro/contracts/tools";
import { TriggerSchema, triggerId } from "@cerebro/contracts/triggers";
import type { Trigger, TriggerOrigin } from "@cerebro/contracts/triggers";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { Effect, Schema } from "effect";

import { ProfileChanged } from "./conversation-bindings.ts";
import type { ConversationProfile } from "./conversation-profile.ts";
import { piContext } from "./pi-harness.ts";
import { ReminderOrigins } from "./saved-timer-state.ts";
import type { SavedTimerOccurrence } from "./saved-timer-state.ts";
import type { SessionHostConfiguration } from "./session-agent.ts";
import type { Triggers } from "./triggers.ts";

interface TimerProfile {
  readonly runtime: Pick<ConversationProfile["runtime"], "authorize"> & {
    readonly configuration: Pick<
      SessionHostConfiguration,
      | "address"
      | "ownerContext"
      | "contentDependencies"
      | "checkDependencies"
      | "replyPorts"
    >;
  };
}
interface TimerOptions {
  readonly pi: Harness;
  readonly nativeId: ConversationId;
  readonly triggers: Pick<Triggers, "admit" | "read">;
  readonly current: () => TimerProfile;
  readonly occurrence: SavedTimerOccurrence;
}
const prepareTrigger = async (
  options: TimerOptions,
  profile: TimerProfile,
  owner: ExecutionContext,
  id: string,
  origin: Extract<TriggerOrigin, { kind: "timer" }>
): Promise<Trigger> => {
  const { configuration } = profile.runtime;
  const saved = await options.pi.snapshot(
    ReminderOrigins,
    options.nativeId,
    options.occurrence.reminderId,
    piContext()
  );
  const dependencies = (await configuration.contentDependencies?.()) ?? {
    sourceIds: [],
    toolIds: [],
  };
  try {
    return Schema.decodeUnknownSync(TriggerSchema, {
      onExcessProperty: "error",
    })({
      version: 2,
      id,
      address: configuration.address,
      ownerPrincipalId: owner.represented?.id ?? owner.actor.id,
      origin,
      text: options.occurrence.instruction,
      reference: null,
      reply: saved?.record?.reply ?? null,
      dependencies,
    });
  } catch {
    throw new InvalidInput({
      reason:
        "The saved instruction cannot be transferred within its content limits.",
    });
  }
};
const authorizeTrigger = async (
  profile: TimerProfile,
  owner: ExecutionContext,
  trigger: Trigger
): Promise<void> => {
  const { configuration } = profile.runtime;
  await Effect.runPromise(
    configuration.checkDependencies(owner, trigger.dependencies, {
      deadlineAt: Date.now() + 30_000,
    })
  );
  if (trigger.reply) {
    const port = configuration.replyPorts?.[trigger.reply.kind];
    if (!port) {
      throw new Denied({
        code: "revoked",
        reason: "Timer reply delivery is unavailable.",
      });
    }
    await port.authorize(trigger.reply);
  }
};
const attempt = async (
  options: TimerOptions,
  profile: TimerProfile
): Promise<void> => {
  const { runtime } = profile;
  const { configuration } = runtime;
  const owner = await Effect.runPromise(configuration.ownerContext());
  await runtime.authorize(owner, "transfer");
  const origin = {
    kind: "timer" as const,
    scheduleId: `saved-timer:${await digestToolArguments([configuration.address, options.occurrence.reminderId])}`,
    occurrenceId: String(options.occurrence.occurrence),
  };
  const id = await triggerId(configuration.address, origin);
  let saved: Trigger | undefined;
  try {
    const receipt = await options.triggers.read(id, owner);
    saved = receipt.trigger;
  } catch (error) {
    if (!(error instanceof NotFound)) {
      throw error;
    }
  }
  if (
    saved &&
    (saved.text !== options.occurrence.instruction ||
      saved.ownerPrincipalId !== (owner.represented?.id ?? owner.actor.id))
  ) {
    throw new Conflict({
      code: "digest-mismatch",
      reason: "The timer occurrence changed.",
    });
  }
  const trigger =
    saved ?? (await prepareTrigger(options, profile, owner, id, origin));
  await authorizeTrigger(profile, owner, trigger);
  if (profile !== options.current()) {
    throw new ProfileChanged();
  }
  await options.triggers.admit(trigger, owner);
};
export const submitSavedTimer = async (
  options: TimerOptions
): Promise<void> => {
  for (;;) {
    try {
      await attempt(options, options.current());
      return;
    } catch (error) {
      if (error instanceof ProfileChanged) {
        continue;
      }
      throw error;
    }
  }
};
