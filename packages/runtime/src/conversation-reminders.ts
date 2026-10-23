import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
} from "@cerebro/contracts/failures";
import { ChatRecurrence } from "@cerebro/contracts/session-service";
import type { ChatReminder } from "@cerebro/contracts/session-service";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineTool } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Harness,
  JsonObject,
} from "@earendil-works/pi-durable";
import type { LifecycleJobOutcome, LifecycleJobs } from "agents/lifecycle";
import { Schema } from "effect";

import { piContext } from "./pi-harness.ts";
import { nextRecurrenceRunAt, validateRecurrence } from "./recurrence.ts";
import type { MetadataTransaction } from "./session-agent.ts";

const MAX_DELAY_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_REMINDERS = 100;
const DISPLAY_TERMINAL_REMINDERS = 16;
const DISPLAY_INSTRUCTION_CHARACTERS = 256;
const RETRY_MS = 5000;
const TIMEZONE_SUFFIX = /(?:Z|[+-]\d{2}:\d{2})$/iu;
const inputSchema = Schema.Struct({
  instruction: Schema.NonEmptyString,
  recurrence: Schema.optional(ChatRecurrence),
  runAt: Schema.Number.check(Schema.isFinite()),
});
export type ReminderInput = typeof inputSchema.Type;
const payloadSchema = Schema.Struct({
  input: inputSchema,
  occurrence: Schema.Number.check(Schema.isFinite()),
  reminderId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
});
export const ReminderPayload = payloadSchema;

interface StoredReminder extends JsonObject {
  fingerprint: string;
  id: string;
  instruction: string;
  initialRunAt: number;
  lastDeliveredAt: number | null;
  recurrence: {
    interval: number;
    timezone: string;
    unit: ChatRecurrence["unit"];
  } | null;
  runAt: number;
  state: ChatReminder["state"];
}
const Reminders = defineDoc({
  fork: "initial",
  history: "latest",
  initial: (): { reminders: Record<string, StoredReminder> } => ({
    reminders: {},
  }),
  kind: "cerebro.reminders",
  scope: "conversation",
  version: 1,
});
const publicReminder = (value: StoredReminder): ChatReminder => ({
  id: value.id,
  instruction: value.instruction,
  ...(value.lastDeliveredAt === null
    ? {}
    : { lastDeliveredAt: value.lastDeliveredAt }),
  ...(value.recurrence ? { recurrence: { ...value.recurrence } } : {}),
  runAt: value.runAt,
  state: value.state,
});
const instructionPreview = (instruction: string): string => {
  let preview = "";
  let count = 0;
  for (const character of instruction) {
    if (count === DISPLAY_INSTRUCTION_CHARACTERS) {
      break;
    }
    preview += character;
    count += 1;
  }
  return preview;
};
const copyStored = (value: StoredReminder): StoredReminder => ({
  ...value,
  ...(value.recurrence ? { recurrence: { ...value.recurrence } } : {}),
});
const initialInput = (value: StoredReminder): ReminderInput => ({
  instruction: value.instruction,
  ...(value.recurrence ? { recurrence: { ...value.recurrence } } : {}),
  runAt: value.initialRunAt,
});
const fingerprint = (input: ReminderInput): string =>
  JSON.stringify([
    input.instruction,
    input.runAt,
    input.recurrence
      ? [
          input.recurrence.unit,
          input.recurrence.interval,
          input.recurrence.timezone,
        ]
      : null,
  ]);
const normalize = (
  input: ReminderInput,
  now: number,
  allowPast = false
): ReminderInput => {
  let parsed: ReminderInput;
  try {
    parsed = Schema.decodeUnknownSync(inputSchema)(input);
  } catch {
    throw new InvalidInput({ reason: "The reminder input is invalid." });
  }
  if (
    parsed.instruction.length > 32_000 ||
    !Number.isSafeInteger(parsed.runAt) ||
    parsed.runAt < 0 ||
    (!allowPast && parsed.runAt <= now) ||
    parsed.runAt > now + MAX_DELAY_MS
  ) {
    throw new InvalidInput({
      reason:
        "A reminder needs an instruction up to 32000 characters and a future deadline within 366 days.",
    });
  }
  try {
    if (parsed.recurrence) {
      validateRecurrence(parsed.recurrence);
    }
  } catch {
    throw new InvalidInput({ reason: "The reminder recurrence is invalid." });
  }
  return parsed;
};

export const createConversationReminders = (services: {
  readonly pi: Harness;
  readonly nativeId: ConversationId;
  readonly sessionId: string;
  readonly jobs: LifecycleJobs;
  readonly authorize: () => Promise<void>;
  readonly authorizeCancel?: () => Promise<void>;
  readonly submit: (text: string, operationId: string) => Promise<unknown>;
  readonly metadata: MetadataTransaction;
  readonly persist: () => Promise<void>;
  readonly now?: () => number;
}) => {
  const now = services.now ?? Date.now;
  const lanes = new Map<string, Promise<unknown>>();
  const serial = async <A>(
    id: string,
    operation: () => Promise<A>
  ): Promise<A> => {
    const previous = lanes.get(id) ?? Promise.resolve();
    const execute = async (): Promise<A> => {
      await Promise.allSettled([previous]);
      return await operation();
    };
    const current = execute();
    lanes.set(id, current);
    try {
      return await current;
    } finally {
      if (lanes.get(id) === current) {
        lanes.delete(id);
      }
    }
  };
  const jobId = (id: string): string =>
    `cerebro-reminder:${services.sessionId}:${id}`;
  const read = async (id: string): Promise<StoredReminder | undefined> => {
    const doc = await services.pi.snapshot(
      Reminders,
      services.nativeId,
      piContext()
    );
    return doc?.reminders[id];
  };
  const arm = (reminder: StoredReminder): Promise<void> =>
    services.metadata(async () => {
      await services.jobs.push({
        fn: "cerebro-reminder",
        id: jobId(reminder.id),
        payload: {
          input: initialInput(reminder),
          occurrence: reminder.runAt,
          reminderId: reminder.id,
          sessionId: services.sessionId,
        },
        recoveryLoop: true,
        singleflight: true,
        time: Math.max(now(), reminder.runAt),
      });
    });
  const admit = (id: string, input: ReminderInput): Promise<StoredReminder> =>
    services.pi.commit(async (tx) => {
      const doc = await tx.doc(Reminders, services.nativeId);
      const existing = doc.reminders[id];
      const digest = fingerprint(input);
      if (existing) {
        if (existing.fingerprint !== digest) {
          throw new Conflict({
            code: "digest-mismatch",
            reason: "The reminder operation names another schedule.",
          });
        }
        return copyStored(existing);
      }
      if (
        Object.values<StoredReminder>(doc.reminders).filter(
          (value) => value.state === "scheduled"
        ).length >= MAX_ACTIVE_REMINDERS
      ) {
        throw new InvalidInput({
          reason: "This chat already has 100 active reminders.",
        });
      }
      const created: StoredReminder = {
        fingerprint: digest,
        id,
        initialRunAt: input.runAt,
        instruction: input.instruction,
        lastDeliveredAt: null,
        recurrence: input.recurrence ? { ...input.recurrence } : null,
        runAt: input.runAt,
        state: "scheduled",
      };
      doc.reminders[id] = created;
      return created;
    }, piContext());
  const schedule = async (
    input: ReminderInput,
    operationId: string,
    signal?: AbortSignal
  ): Promise<ChatReminder> => {
    await services.authorize();
    signal?.throwIfAborted();
    if (!operationId || operationId.length > 512) {
      throw new InvalidInput({
        reason: "A reminder operation ID is required.",
      });
    }
    const id = `reminder:${operationId}`;
    return serial(id, async () => {
      signal?.throwIfAborted();
      const existing = await read(id);
      const retained = await services.metadata(() =>
        services.jobs.get(jobId(id))
      );
      const normalized = normalize(
        input,
        now(),
        existing !== undefined || retained !== undefined
      );
      if (existing) {
        if (existing.fingerprint !== fingerprint(normalized)) {
          throw new Conflict({
            code: "digest-mismatch",
            reason: "The reminder operation names another schedule.",
          });
        }
        if (existing.state === "scheduled") {
          await arm(existing);
        }
        return publicReminder(existing);
      }
      await services.metadata(async () => {
        signal?.throwIfAborted();
        const pending = services.jobs.get(jobId(id));
        if (pending) {
          const seed = Schema.decodeUnknownSync(payloadSchema)(pending.payload);
          if (
            seed.sessionId !== services.sessionId ||
            seed.reminderId !== id ||
            fingerprint(seed.input) !== fingerprint(normalized)
          ) {
            throw new Conflict({
              code: "digest-mismatch",
              reason: "The reminder operation names another schedule.",
            });
          }
          await services.jobs.rearm();
          return;
        }
        await services.jobs.push({
          fn: "cerebro-reminder",
          id: jobId(id),
          payload: {
            input: normalized,
            occurrence: normalized.runAt,
            reminderId: id,
            sessionId: services.sessionId,
          },
          recoveryLoop: true,
          singleflight: true,
          time: normalized.runAt,
        });
      });
      let created: StoredReminder;
      try {
        created = await admit(id, normalized);
      } catch (error) {
        if (error instanceof InvalidInput) {
          await services.metadata(() => services.jobs.cancel(jobId(id)));
        }
        throw error;
      }
      await services.persist();
      return publicReminder(created);
    });
  };
  const cancel = async (id: string): Promise<ChatReminder> => {
    await (services.authorizeCancel ?? services.authorize)();
    return serial(id, async () => {
      if (!(await read(id))) {
        const retained = await services.metadata(() =>
          services.jobs.get(jobId(id))
        );
        if (retained) {
          const seed = Schema.decodeUnknownSync(payloadSchema)(
            retained.payload
          );
          if (seed.sessionId === services.sessionId && seed.reminderId === id) {
            await admit(id, normalize(seed.input, now(), true));
          }
        }
      }
      const cancelled = await services.pi.commit(async (tx) => {
        const doc = await tx.doc(Reminders, services.nativeId);
        const reminder = doc.reminders[id];
        if (!reminder) {
          throw new NotFound({ resource: "Reminder" });
        }
        if (reminder.state === "scheduled") {
          reminder.state = "cancelled";
        }
        return publicReminder(reminder);
      }, piContext());
      await services.metadata(() => services.jobs.cancel(jobId(id)));
      await services.persist();
      return cancelled;
    });
  };
  const deliver = (
    id: string,
    occurrence: number,
    seed?: ReminderInput
  ): Promise<LifecycleJobOutcome> =>
    serial(id, async () => {
      let reminder = await read(id);
      if (!reminder && seed) {
        try {
          reminder = await admit(id, normalize(seed, now(), true));
        } catch (error) {
          if (error instanceof InvalidInput) {
            return;
          }
          throw error;
        }
      }
      if (!reminder || reminder.state !== "scheduled") {
        return;
      }
      if (reminder.runAt !== occurrence || occurrence > now()) {
        await arm(reminder);
        return { rescheduleAt: reminder.runAt };
      }
      try {
        await services.authorize();
        await services.submit(
          `Scheduled instruction (${id}, ${new Date(occurrence).toISOString()}):\n${reminder.instruction}`,
          `${id}:${occurrence}`
        );
      } catch (error) {
        if (
          !(
            error instanceof Denied ||
            error instanceof NotFound ||
            error instanceof InvalidInput
          )
        ) {
          return { rescheduleAt: now() + RETRY_MS };
        }
        await services.pi.commit(async (tx) => {
          const doc = await tx.doc(Reminders, services.nativeId);
          const value = doc.reminders[id];
          if (value?.state === "scheduled" && value.runAt === occurrence) {
            value.state = "revoked";
          }
        }, piContext());
        await services.persist();
        return;
      }
      const updated = await services.pi.commit(async (tx) => {
        const doc = await tx.doc(Reminders, services.nativeId);
        const value = doc.reminders[id];
        if (
          !value ||
          value.state !== "scheduled" ||
          value.runAt !== occurrence
        ) {
          return value ? copyStored(value) : undefined;
        }
        value.lastDeliveredAt = occurrence;
        if (value.recurrence) {
          value.runAt = nextRecurrenceRunAt(
            occurrence,
            value.recurrence,
            now()
          );
        } else {
          value.state = "completed";
        }
        return copyStored(value);
      }, piContext());
      await services.persist();
      if (updated?.state === "scheduled") {
        await arm(updated);
        return { rescheduleAt: updated.runAt };
      }
    });
  const list = async (): Promise<ChatReminder[]> => {
    const doc = await services.pi.snapshot(
      Reminders,
      services.nativeId,
      piContext()
    );
    const reminders = Object.values(doc?.reminders ?? {});
    const scheduled = reminders.filter((value) => value.state === "scheduled");
    const terminal = reminders
      .filter((value) => value.state !== "scheduled")
      .slice(-DISPLAY_TERMINAL_REMINDERS);
    return [...scheduled, ...terminal]
      .map((value) => ({
        ...publicReminder(value),
        instruction: instructionPreview(value.instruction),
      }))
      .toSorted(
        (left, right) =>
          left.runAt - right.runAt || left.id.localeCompare(right.id)
      );
  };
  const restore = async (): Promise<void> => {
    const doc = await services.pi.snapshot(
      Reminders,
      services.nativeId,
      piContext()
    );
    const reminders = Object.values(doc?.reminders ?? {}).filter(
      (reminder) => reminder.state === "scheduled"
    );
    await Promise.all(
      reminders.map((reminder) =>
        serial(reminder.id, async () => {
          const current = await read(reminder.id);
          if (current?.state === "scheduled") {
            await arm(current);
          }
        })
      )
    );
  };
  const recurrenceParameters = Type.Object({
    interval: Type.Integer({ maximum: 1000, minimum: 1 }),
    timezone: Type.String({ maxLength: 100, minLength: 1 }),
    unit: Type.Union([
      Type.Literal("minute"),
      Type.Literal("hour"),
      Type.Literal("day"),
      Type.Literal("week"),
      Type.Literal("month"),
    ]),
  });
  const tools = [
    defineTool({
      description:
        "Schedule an instruction in this chat. Give exactly one of delaySeconds or at. Recurrences continue automatically until cancelled.",
      execute: async (args, api, context) => {
        const memo = await api.memo<ReminderInput>(
          "cerebro.reminder-input",
          context
        );
        let input = memo;
        if (!input) {
          if ((args.delaySeconds === undefined) === (args.at === undefined)) {
            throw new InvalidInput({
              reason: "Give exactly one of delaySeconds or at.",
            });
          }
          let runAt = Number.NaN;
          if (args.delaySeconds !== undefined) {
            runAt = now() + args.delaySeconds * 1000;
          } else if (args.at && TIMEZONE_SUFFIX.test(args.at)) {
            runAt = Date.parse(args.at);
          }
          const proposed = normalize(
            {
              instruction: args.instruction,
              ...(args.recurrence ? { recurrence: args.recurrence } : {}),
              runAt,
            },
            now()
          );
          input = await api.memo("cerebro.reminder-input", proposed, context);
        }
        const value = await schedule(
          input,
          `tool:${api.taskId}`,
          context.abortSignal
        );
        return {
          details: value,
          output: [{ text: JSON.stringify(value), type: "text" }],
        };
      },
      name: "schedule",
      parameters: Type.Object({
        at: Type.Optional(
          Type.String({
            description: "ISO 8601 deadline with timezone offset.",
          })
        ),
        delaySeconds: Type.Optional(
          Type.Integer({ maximum: MAX_DELAY_MS / 1000, minimum: 1 })
        ),
        instruction: Type.String({ maxLength: 32_000, minLength: 1 }),
        recurrence: Type.Optional(recurrenceParameters),
      }),
      replay: "safe",
    }),
    defineTool({
      description:
        "Cancel a reminder in this chat. An instruction already admitted can be stopped with the chat Stop control.",
      execute: async ({ id }) => ({
        output: [{ text: JSON.stringify(await cancel(id)), type: "text" }],
      }),
      name: "cancel_schedule",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
      replay: "safe",
    }),
  ];
  return { cancel, deliver, list, restore, schedule, tools };
};
