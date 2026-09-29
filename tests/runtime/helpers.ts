import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import type {
  EventAddress,
  EventEnvelope,
} from "../../packages/contracts/src/events.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type { ExecutionContext } from "../../packages/contracts/src/identity.ts";

export interface Stack {
  readonly project: string;
  readonly apiPort: number;
  readonly fixturePort: number;
  readonly effectMode?: "idempotent" | "non-idempotent";
  readonly holdAfterEffect?: boolean;
}

export const compose = (stack: Stack, args: readonly string[]): string => {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      "tests/runtime/compose.yaml",
      "-p",
      stack.project,
      ...args,
    ],
    {
      cwd: new URL("../../", import.meta.url).pathname,
      encoding: "utf-8",
      env: {
        ...process.env,
        COMPOSE_PROJECT_NAME: stack.project,
        RUNTIME_API_PORT: String(stack.apiPort),
        RUNTIME_EFFECT_MODE: stack.effectMode ?? "idempotent",
        RUNTIME_FIXTURE_PORT: String(stack.fixturePort),
        RUNTIME_HOLD_AFTER_EFFECT: stack.holdAfterEffect === false ? "0" : "1",
      },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 600_000,
    }
  );
  const diagnostics =
    result.status === 0
      ? ""
      : spawnSync(
          "docker",
          [
            "compose",
            "-f",
            "tests/runtime/compose.yaml",
            "-p",
            stack.project,
            "logs",
            "--no-color",
            "--tail=60",
            "bootstrap",
            "celld",
          ],
          {
            cwd: new URL("../../", import.meta.url).pathname,
            encoding: "utf-8",
            timeout: 30_000,
          }
        ).stdout;
  assert.equal(
    result.status,
    0,
    `docker compose ${args.join(" ")} failed\n${diagnostics}\n${result.stdout}\n${result.stderr}`
  );
  return `${result.stdout}\n${result.stderr}`;
};

export const request = async <Value>(
  stack: Stack,
  path: string,
  body: unknown
): Promise<Value> => {
  const response = await fetch(`http://127.0.0.1:${stack.apiPort}${path}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200) {
    assert.fail(`HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as Value;
};

export const getFixture = async <Value>(
  stack: Stack,
  path: string
): Promise<Value> => {
  const response = await fetch(`http://127.0.0.1:${stack.fixturePort}${path}`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as Value;
};

export const releaseEffect = async (
  stack: Stack,
  operationId: string
): Promise<void> => {
  const response = await fetch(
    `http://127.0.0.1:${stack.fixturePort}/release/${encodeURIComponent(operationId)}`,
    {
      method: "POST",
    }
  );
  assert.equal(response.status, 200);
};

export const waitFor = async <Value>(
  read: () => Promise<Value>,
  matches: (value: Value) => boolean,
  timeoutMs = 60_000
): Promise<Value> => {
  const deadline = Date.now() + timeoutMs;
  let last: Value | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      // Each read depends on the previous result and delay.
      // oxlint-disable-next-line no-await-in-loop
      last = await read();
      if (matches(last)) {
        return last;
      }
    } catch (error) {
      lastError = error;
    }
    // Polling must read the state after each delay.
    // oxlint-disable-next-line no-await-in-loop
    await delay(500);
  }
  throw new Error(
    `Condition was not met. Last value: ${JSON.stringify(last)}. Last error: ${String(lastError)}`
  );
};

export const fixtureContext = (organizationId: string): ExecutionContext => ({
  actor: {
    id: id.principal(`user:${organizationId}`),
    kind: "human",
    organizationId: id.organization(organizationId),
    state: "active",
  },
});

export const addressFor = (
  organizationId: string,
  conversationId: string
): EventAddress => ({
  agentId: id.agent("agent-1"),
  conversationId: id.conversation(conversationId),
  organizationId: id.organization(organizationId),
  sessionId: id.session(`session:${organizationId}:${conversationId}`),
});

export const messageEvent = (
  address: EventAddress,
  eventId: string
): EventEnvelope => ({
  ...address,
  context: fixtureContext(address.organizationId),
  event: {
    payload: { text: "Apply the fixture effect." },
    type: "user.message",
  },
  eventId: id.event(eventId),
  occurredAt: Date.now(),
  payloadDigest: id.digest(`sha256:${eventId}`),
  schemaVersion: 1,
});

export const effectOptions = (operationId: string, digest: string) => ({
  deadlineAt: Date.now() + 600_000,
  operationId: id.operation(operationId),
  requestDigest: id.digest(digest),
});
