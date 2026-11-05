import assert from "node:assert/strict";
import { test } from "node:test";

import { createSlackApi } from "../../packages/channels/src/slack-api.ts";

const configuration = {
  workspaceId: "workspace-A",
  appId: "app-A",
  agentId: "agent-A",
  signingSecret: "unused",
  botToken: "fixture",
};

test("Slack 429 retains a valid Retry-After deadline and omits missing or invalid values", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const headers = [
    "30",
    "60",
    "0",
    null,
    "",
    "bad",
    "-1",
    "1.5",
    "Infinity",
    "999999999999999999999999999",
    "Mon, 02 Nov 2026 12:00:00 GMT",
  ];
  const api = createSlackApi(configuration, () => {
    const value = headers.shift();
    return Promise.resolve(
      new Response("slow down", {
        status: 429,
        headers:
          value === null || value === undefined ? {} : { "Retry-After": value },
      })
    );
  });
  const message = { channel: "D-A", text: "Saved reply." };
  assert.deepEqual(await api.send(message), {
    state: "retry",
    retryAt: now + 30_000,
  });
  assert.deepEqual(await api.send(message), {
    state: "retry",
    retryAt: now + 60_000,
  });
  assert.deepEqual(await api.send(message), { state: "retry", retryAt: now });
  const invalid = await Promise.all(
    Array.from({ length: 8 }, () => api.send(message))
  );
  assert.deepEqual(
    invalid,
    Array.from({ length: 8 }, () => ({ state: "retry" }))
  );
});
