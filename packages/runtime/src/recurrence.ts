import { ChatRecurrence } from "@cerebro/contracts/session-service";
import { Schema } from "effect";

interface LocalDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const formatters = new Map<string, Intl.DateTimeFormat>();

const formatter = (timezone: string): Intl.DateTimeFormat => {
  const existing = formatters.get(timezone);
  if (existing) {
    return existing;
  }
  const created = new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
    calendar: "iso8601",
    day: "numeric",
    hour: "numeric",
    hourCycle: "h23",
    minute: "numeric",
    month: "numeric",
    second: "numeric",
    timeZone: timezone,
    year: "numeric",
  });
  formatters.set(timezone, created);
  return created;
};

export const validateRecurrence = (value: ChatRecurrence): void => {
  Schema.decodeUnknownSync(ChatRecurrence)(value);
  formatter(value.timezone).format(0);
};

const localTime = (timestamp: number, timezone: string): LocalDateTime => {
  const parts = formatter(timezone).formatToParts(timestamp);
  const field = (name: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((value) => value.type === name);
    if (!part) {
      throw new Error(`The timezone formatter omitted ${name}.`);
    }
    return Number(part.value);
  };
  return {
    day: field("day"),
    hour: field("hour"),
    millisecond: ((timestamp % 1000) + 1000) % 1000,
    minute: field("minute"),
    month: field("month"),
    second: field("second"),
    year: field("year"),
  };
};

const localEpoch = (value: LocalDateTime): number =>
  Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
    value.millisecond
  );

const resolveLocal = (value: LocalDateTime, timezone: string): number => {
  const target = localEpoch(value);
  const offsets = new Set<number>();
  for (const distance of [-2 * DAY_MS, -DAY_MS, 0, DAY_MS, 2 * DAY_MS]) {
    const sample = target + distance;
    offsets.add(localEpoch(localTime(sample, timezone)) - sample);
  }
  const candidates = [...offsets].map((offset) => target - offset);
  const exact = candidates
    .filter(
      (candidate) => localEpoch(localTime(candidate, timezone)) === target
    )
    .toSorted((left, right) => left - right);
  const [first] = exact;
  if (first !== undefined) {
    return first;
  }
  const [shifted] = candidates
    .map((candidate) => ({
      candidate,
      delta: localEpoch(localTime(candidate, timezone)) - target,
    }))
    .filter((candidate) => candidate.delta > 0)
    .toSorted(
      (left, right) =>
        left.delta - right.delta || left.candidate - right.candidate
    );
  if (!shifted) {
    throw new Error(`Cannot resolve recurrence in ${timezone}.`);
  }
  return shifted.candidate;
};

const advance = (
  value: LocalDateTime,
  recurrence: ChatRecurrence
): LocalDateTime => {
  if (recurrence.unit === "month") {
    const monthIndex = value.year * 12 + value.month - 1 + recurrence.interval;
    const year = Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { ...value, day: Math.min(value.day, lastDay), month, year };
  }
  const date = new Date(
    localEpoch(value) +
      recurrence.interval * (recurrence.unit === "week" ? 7 : 1) * DAY_MS
  );
  return {
    ...value,
    day: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    year: date.getUTCFullYear(),
  };
};

export const nextRecurrenceRunAt = (
  previous: number,
  recurrence: ChatRecurrence,
  now: number
): number => {
  validateRecurrence(recurrence);
  if (recurrence.unit === "minute" || recurrence.unit === "hour") {
    const duration =
      recurrence.interval *
      (recurrence.unit === "minute" ? MINUTE_MS : HOUR_MS);
    const next =
      previous +
      Math.max(1, Math.floor((now - previous) / duration) + 1) * duration;
    if (!Number.isSafeInteger(next)) {
      throw new TypeError(
        "The next recurrence is outside the supported time range."
      );
    }
    return next;
  }
  let local = localTime(previous, recurrence.timezone);
  for (let count = 0; count < 1_000_000; count += 1) {
    local = advance(local, recurrence);
    const next = resolveLocal(local, recurrence.timezone);
    if (next > now) {
      return next;
    }
    local = localTime(next, recurrence.timezone);
  }
  throw new Error("The recurrence exceeds its catch-up limit.");
};
