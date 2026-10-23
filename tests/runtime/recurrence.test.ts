import assert from "node:assert/strict";
import { test } from "node:test";

import { nextRecurrenceRunAt } from "../../packages/runtime/src/recurrence.ts";

test("calendar reminders retain local time across daylight saving changes", () => {
  const daily = {
    interval: 1,
    timezone: "America/New_York",
    unit: "day" as const,
  };
  assert.equal(
    new Date(
      nextRecurrenceRunAt(
        Date.parse("2026-03-07T14:00:00Z"),
        daily,
        Date.parse("2026-03-07T14:00:00Z")
      )
    ).toISOString(),
    "2026-03-08T13:00:00.000Z"
  );
  assert.equal(
    new Date(
      nextRecurrenceRunAt(
        Date.parse("2026-10-31T13:00:00Z"),
        daily,
        Date.parse("2026-10-31T13:00:00Z")
      )
    ).toISOString(),
    "2026-11-01T14:00:00.000Z"
  );
});

test("calendar reminders move skipped local times forward and select the earlier repeated time", () => {
  const daily = {
    interval: 1,
    timezone: "America/New_York",
    unit: "day" as const,
  };
  assert.equal(
    new Date(
      nextRecurrenceRunAt(
        Date.parse("2026-03-07T07:30:00Z"),
        daily,
        Date.parse("2026-03-07T07:30:00Z")
      )
    ).toISOString(),
    "2026-03-08T07:30:00.000Z"
  );
  assert.equal(
    new Date(
      nextRecurrenceRunAt(
        Date.parse("2026-10-31T05:30:00Z"),
        daily,
        Date.parse("2026-10-31T05:30:00Z")
      )
    ).toISOString(),
    "2026-11-01T05:30:00.000Z"
  );
});

test("monthly reminders clamp month-end dates and skip missed occurrences", () => {
  assert.equal(
    new Date(
      nextRecurrenceRunAt(
        Date.parse("2026-01-31T15:00:00Z"),
        { interval: 1, timezone: "UTC", unit: "month" },
        Date.parse("2026-01-31T15:00:00Z")
      )
    ).toISOString(),
    "2026-02-28T15:00:00.000Z"
  );
  assert.equal(
    new Date(
      nextRecurrenceRunAt(
        Date.parse("2026-10-01T09:00:00Z"),
        { interval: 1, timezone: "UTC", unit: "day" },
        Date.parse("2026-10-05T10:00:00Z")
      )
    ).toISOString(),
    "2026-10-06T09:00:00.000Z"
  );
  assert.equal(
    new Date(
      nextRecurrenceRunAt(
        Date.parse("2026-10-01T09:00:00Z"),
        { interval: 2, timezone: "UTC", unit: "minute" },
        Date.parse("2026-10-01T09:07:00Z")
      )
    ).toISOString(),
    "2026-10-01T09:08:00.000Z"
  );
});

test("recurrence rejects invalid intervals and timezone identifiers", () => {
  assert.throws(
    () =>
      nextRecurrenceRunAt(
        1000,
        { interval: 0, timezone: "UTC", unit: "day" },
        1000
      ),
    /interval/u
  );
  assert.throws(
    () =>
      nextRecurrenceRunAt(
        1000,
        { interval: 1001, timezone: "UTC", unit: "minute" },
        1000
      ),
    /interval/u
  );
  assert.equal(
    nextRecurrenceRunAt(
      1000,
      { interval: 1000, timezone: "UTC", unit: "minute" },
      1000
    ),
    60_001_000
  );
  assert.throws(
    () =>
      nextRecurrenceRunAt(
        1000,
        { interval: 1, timezone: "Missing/Timezone", unit: "day" },
        1000
      ),
    RangeError
  );
  assert.equal(
    nextRecurrenceRunAt(
      1000,
      { interval: 1, timezone: "UTC", unit: "hour" },
      1000
    ),
    3_601_000
  );
});
