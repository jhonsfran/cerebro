/* oxlint-disable no-await-in-loop -- A changed profile requires a new authorization before the next occurrence attempt. */
import { botEventId, BotEventSchema } from "@cerebro/contracts/bot-events";
import type { BotEvent } from "@cerebro/contracts/bot-events";
import { Conflict, Denied, InvalidInput } from "@cerebro/contracts/failures";
import type {
  ExecutionContext,
  PrincipalId,
} from "@cerebro/contracts/identity";
import type { FixedReplyOrigin } from "@cerebro/contracts/timer-events";
import { digestToolArguments } from "@cerebro/contracts/tools";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { Effect, Schema } from "effect";

import { ProfileChanged } from "./conversation-bindings.ts";
import type { ConversationProfile } from "./conversation-profile.ts";
import type { CoordinatorEvents } from "./coordinator-events.ts";
import { sameWorkSource } from "./coordinator-ledger.ts";
import { piContext } from "./pi-harness.ts";
import {
  ReminderOrigins,
  TimerOccurrences,
  copyTimerOccurrence,
  resolveFixedReplyOrigin,
} from "./saved-timer-state.ts";
import type {
  SavedTimerOccurrence,
  TimerOccurrenceRecord,
} from "./saved-timer-state.ts";
import type { SessionHostConfiguration } from "./session-agent.ts";

interface TimerProfile {
  readonly runtime: Pick<
    ConversationProfile["runtime"],
    "authorize" | "guardIn"
  > & {
    readonly configuration: Pick<
      SessionHostConfiguration,
      | "address"
      | "ownerContext"
      | "contentDependencies"
      | "checkDependencies"
      | "eventReplies"
    >;
  };
}
interface TimerOptions {
  readonly pi: Harness;
  readonly nativeId: ConversationId;
  readonly events: CoordinatorEvents;
  readonly current: () => TimerProfile;
  readonly occurrence: SavedTimerOccurrence;
}
const requireOccurrence = (
  record: TimerOccurrenceRecord,
  options: TimerOptions,
  profile: TimerProfile,
  owner: PrincipalId
): void => {
  const { occurrence } = options;
  if (
    !sameWorkSource(record.source, profile.runtime.configuration.address) ||
    record.reminderId !== occurrence.reminderId ||
    record.fingerprint !== occurrence.fingerprint ||
    record.occurrence !== occurrence.occurrence ||
    record.event.content.text !== occurrence.instruction ||
    record.event.ownerPrincipalId !== owner
  ) {
    throw new Conflict({
      code: "digest-mismatch",
      reason: "The timer occurrence changed.",
    });
  }
};
const authorizeOccurrence = async (
  profile: TimerProfile,
  owner: ExecutionContext,
  record: TimerOccurrenceRecord
): Promise<void> => {
  const { configuration } = profile.runtime;
  await Effect.runPromise(
    configuration.checkDependencies(owner, record.event.dependencies, {
      deadlineAt: Date.now() + 30_000,
    })
  );
  if (record.destination) {
    if (!configuration.eventReplies) {
      throw new Denied({
        code: "revoked",
        reason: "Timer reply delivery is unavailable.",
      });
    }
    await configuration.eventReplies.authorize(record.destination);
  }
};
const prepareOccurrence = async (
  options: TimerOptions,
  profile: TimerProfile,
  owner: ExecutionContext,
  eventId: string,
  source: Extract<BotEvent["source"], { kind: "savedtimer" }>,
  target: BotEvent["coordinator"]
): Promise<TimerOccurrenceRecord> => {
  const { configuration } = profile.runtime;
  const origin = await options.pi.snapshot(
    ReminderOrigins,
    options.nativeId,
    options.occurrence.reminderId,
    piContext()
  );
  const replyOrigin: FixedReplyOrigin = origin?.record?.reply ?? {
    kind: "web",
  };
  const dependencies = (await configuration.contentDependencies?.()) ?? {
    sourceIds: [],
    toolIds: [],
  };
  await Effect.runPromise(
    configuration.checkDependencies(owner, dependencies, {
      deadlineAt: Date.now() + 30_000,
    })
  );
  const reply = await resolveFixedReplyOrigin(options.pi, replyOrigin);
  let destination = null;
  if (reply) {
    if (!configuration.eventReplies) {
      throw new Denied({
        code: "revoked",
        reason: "Timer reply delivery is unavailable.",
      });
    }
    destination = await configuration.eventReplies.destination(reply);
    await configuration.eventReplies.authorize(destination);
  }
  let event: BotEvent;
  try {
    event = Schema.decodeUnknownSync(BotEventSchema, {
      onExcessProperty: "error",
    })({
      version: 1,
      id: eventId,
      coordinator: target,
      ownerPrincipalId: owner.represented?.id ?? owner.actor.id,
      source,
      replyTo: destination
        ? { kind: "slack", thread: destination.authority.thread }
        : { kind: "web", address: target },
      content: { text: options.occurrence.instruction, reference: null },
      dependencies,
    });
  } catch {
    throw new InvalidInput({
      reason:
        "The saved instruction cannot be transferred within its content limits.",
    });
  }
  return {
    source: { ...configuration.address },
    reminderId: options.occurrence.reminderId,
    fingerprint: options.occurrence.fingerprint,
    occurrence: options.occurrence.occurrence,
    event,
    replyOrigin,
    destination,
  };
};
const attempt = async (
  options: TimerOptions,
  profile: TimerProfile
): Promise<void> => {
  const { runtime } = profile;
  const { configuration } = runtime;
  const owner = await Effect.runPromise(configuration.ownerContext());
  await runtime.authorize(owner, "transfer");
  const target = configuration.address;
  const source = {
    kind: "savedtimer" as const,
    scheduleId: `saved-timer:${await digestToolArguments([configuration.address, options.occurrence.reminderId])}`,
    occurrenceId: String(options.occurrence.occurrence),
  };
  const eventId = await botEventId(target, source);
  const savedOccurrence = await options.pi.snapshot(
    TimerOccurrences,
    eventId,
    piContext()
  );
  let record = savedOccurrence?.record;
  if (!record) {
    const prepared = await prepareOccurrence(
      options,
      profile,
      owner,
      eventId,
      source,
      target
    );
    record = await options.pi.commit(async (tx) => {
      await runtime.guardIn(tx);
      const saved = await tx.doc(TimerOccurrences, eventId, null);
      saved.record ??= prepared;
      return copyTimerOccurrence(saved.record);
    }, piContext());
  }
  requireOccurrence(
    record,
    options,
    profile,
    owner.represented?.id ?? owner.actor.id
  );
  await authorizeOccurrence(profile, owner, record);
  if (profile !== options.current()) {
    throw new ProfileChanged();
  }
  await options.events.admit(record.event, owner);
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
