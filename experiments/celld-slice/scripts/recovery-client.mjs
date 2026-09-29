import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

export const baseURL = process.env.BASE_URL ?? "http://localhost:18765";
export const fixtureURL = process.env.FIXTURE_URL ?? "http://localhost:18766";

export const request = async (base, path, body) => {
  const response = await fetch(`${base}${path}`, {
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  return { body: result, status: response.status };
};

export const session = async (id, path, body) =>
  await request(baseURL, `/recovery/${id}/${path}`, body);

export const fixture = async (path, body) =>
  await request(fixtureURL, path, body);

export const until = async (read, predicate, label, timeout = 90_000) => {
  const deadline = Date.now() + timeout;
  let latest;
  /* oxlint-disable no-await-in-loop -- Each poll depends on the preceding response and delay. */
  while (Date.now() < deadline) {
    latest = await read();
    if (predicate(latest)) {
      return latest;
    }
    await setTimeout(300);
  }
  /* oxlint-enable no-await-in-loop */
  assert.fail(
    `${label} timed out; last observation ${JSON.stringify(latest).slice(0, 2000)}`
  );
};

export const state = async (id, status) =>
  await until(
    async () => {
      const response = await session(id, "state");
      return response.body.run;
    },
    (run) => run?.status === status || run?.status === "failed",
    `${status} for ${id}`
  );

export const submit = async (options = {}) => {
  const id = crypto.randomUUID();
  const response = await session(id, "submit", {
    holdAfterEffect: false,
    mode: "idempotent",
    operationId: id,
    ...options,
  });
  assert.equal(response.status, 202);
  assert.equal(response.body.run.operationId, id);
  return id;
};

export const approve = async (id, run, eventId = crypto.randomUUID()) => {
  const response = await session(id, "approve", {
    digest: run.invocation.digest,
    eventId,
  });
  assert.equal(response.status, 200);
  return { eventId, response };
};
