/* oxlint-disable no-await-in-loop -- Each poll and observation read depends on the previous result. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { Schema } from "effect";

import type {
  EventAddress,
  EventEnvelope,
} from "../../packages/contracts/src/events.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type { ExecutionContext } from "../../packages/contracts/src/identity.ts";
import {
  DomainSnapshot,
  Observation,
} from "../../packages/contracts/src/session-service.ts";
import type { ApprovalState } from "../../packages/contracts/src/session-service.ts";
import type { SessionReceipt } from "../../packages/contracts/src/session.ts";

export interface Stack {
  readonly project: string;
  readonly apiPort: number;
  readonly fixturePort: number;
  readonly failFirstEffect?: boolean;
  readonly traceNative?: boolean;
}
const freePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await promisify(server.close.bind(server))();
  return address.port;
};
export const newStack = async (
  name: string,
  failFirstEffect = false,
  traceNative = false
): Promise<Stack> => ({
  apiPort: await freePort(),
  failFirstEffect,
  fixturePort: await freePort(),
  project: `cerebro-s1-native-host-${name}-${randomUUID().slice(0, 8)}`,
  traceNative,
});
const sourceIdentity = () => {
  const head = spawnSync("rtk", ["proxy", "git", "rev-parse", "HEAD"], {
    encoding: "utf-8",
  }).stdout.trim();
  const hash = createHash("sha256");
  for (const directory of [
    "packages/contracts/src",
    "packages/runtime/src",
    "packages/tools/src",
    "packages/db/src",
    "tests/runtime",
  ]) {
    for (const name of readdirSync(directory, { recursive: true })
      .filter(
        (value): value is string =>
          typeof value === "string" &&
          /\.(?:ts|mjs|json|jsonc|yaml)$/u.test(value)
      )
      .toSorted()) {
      hash.update(`${directory}/${name}\n`);
      hash.update(readFileSync(`${directory}/${name}`));
    }
  }
  hash.update(readFileSync("tests/slice-1/provider.mjs"));
  return `${head}:sha256:${hash.digest("hex")}`;
};
interface SourceSnapshot {
  readonly identity: string;
  readonly dirtyCheckout: boolean;
}
const sources = new Map<string, SourceSnapshot>();
const sourceForStack = (stack: Stack): SourceSnapshot => {
  const previous = sources.get(stack.project);
  if (previous) {
    return previous;
  }
  const status = spawnSync(
    "rtk",
    [
      "proxy",
      "git",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude)artifacts/**",
    ],
    { encoding: "utf-8" }
  );
  assert.equal(status.status, 0, "Source status must be available");
  const value = {
    dirtyCheckout: status.stdout.length > 0,
    identity: sourceIdentity(),
  };
  sources.set(stack.project, value);
  return value;
};
export const compose = (stack: Stack, args: readonly string[]): string => {
  assert.match(stack.project, /^cerebro-s1-native-host-[a-z0-9-]+$/u);
  const result = spawnSync(
    "rtk",
    [
      "proxy",
      "docker",
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
        RUNTIME_FAIL_FIRST_EFFECT: stack.failFirstEffect ? "1" : "0",
        RUNTIME_FIXTURE_PORT: String(stack.fixturePort),
        RUNTIME_SOURCE_SHA: sourceForStack(stack).identity,
        RUNTIME_TRACE_NATIVE: stack.traceNative ? "1" : "0",
      },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 600_000,
    }
  );
  assert.equal(
    result.status,
    0,
    `docker compose ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`
  );
  return `${result.stdout}\n${result.stderr}`;
};
export const boot = (stack: Stack): void => {
  const existing = spawnSync(
    "rtk",
    [
      "proxy",
      "docker",
      "ps",
      "-a",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${stack.project}`,
    ],
    { encoding: "utf-8" }
  );
  assert.equal(existing.status, 0);
  assert.equal(existing.stdout.trim(), "", "A fresh owned project is required");
  compose(stack, ["up", "--build", "-d", "--wait"]);
};
export const rawRequest = async (
  stack: Stack,
  path: string,
  body: unknown,
  principal?: string
): Promise<Response> => {
  const serialized = JSON.stringify(body);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(`http://127.0.0.1:${stack.apiPort}${path}`, {
        body: serialized,
        headers: {
          "Content-Type": "application/json",
          ...(principal ? { "x-fixture-principal": principal } : {}),
        },
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (!(error instanceof TypeError) || attempt === 2) {
        throw error;
      }
      await delay(500);
    }
  }
  throw new Error("Fixture transport retries exhausted");
};
export const request = async <Value>(
  stack: Stack,
  path: string,
  body: unknown,
  principal?: string
): Promise<Value> => {
  const response = await rawRequest(stack, path, body, principal);
  assert.equal(
    response.status,
    200,
    `HTTP ${response.status}: ${await response.clone().text()}`
  );
  const result: unknown = await response.json();
  assert.ok(
    result &&
      typeof result === "object" &&
      "status" in result &&
      result.status === "ok" &&
      "value" in result
  );
  return result.value as Value;
};
// Docker Desktop can refuse a published port for a moment after a container signal.
export const getFixture = async <Value>(
  stack: Stack,
  path = "/observations"
): Promise<Value> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${stack.fixturePort}${path}`,
        { signal: AbortSignal.timeout(10_000) }
      );
      assert.equal(response.status, 200);
      return (await response.json()) as Value;
    } catch (error) {
      if (!(error instanceof TypeError) || attempt === 4) {
        throw error;
      }
      await delay(500);
    }
  }
};
export interface ProviderEvidence {
  readonly fixtureId: string;
  readonly sha: string;
  readonly revision: number;
  readonly held: number;
  readonly tools: readonly {
    readonly operationId: string;
    readonly receipt: string;
    readonly write: boolean;
    readonly completedAt?: number;
  }[];
  readonly model: readonly {
    readonly operationId: string;
    readonly status?: number;
  }[];
  readonly checkpoints: readonly {
    readonly boundary: string;
    readonly operationId: string;
    readonly armed?: boolean;
  }[];
}
export const control = async (stack: Stack, input: unknown): Promise<void> => {
  const response = await fetch(
    `http://127.0.0.1:${stack.fixturePort}/control`,
    {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
        "x-fixture-control": "slice-1-control",
      },
      method: "POST",
    }
  );
  assert.equal(response.status, 200);
};
export const waitFor = async <Value>(
  read: () => Promise<Value> | Value,
  matches: (value: Value) => boolean,
  timeoutMs = 60_000
): Promise<Value> => {
  const deadline = Date.now() + timeoutMs;
  let last: Value | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (matches(last)) {
        return last;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(
    `Condition failed. Last value: ${JSON.stringify(last)}. Last error: ${String(lastError)}`
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
    payload: { text: "Apply fixture_effect once." },
    type: "user.message",
  },
  eventId: id.event(eventId),
  occurredAt: Date.now(),
  payloadDigest: id.digest(`sha256:${eventId}`),
  schemaVersion: 1,
});
export const effectOptions = (
  operationId: string,
  digest = `sha256:${operationId}`
) => ({
  deadlineAt: Date.now() + 600_000,
  operationId: id.operation(operationId),
  requestDigest: id.digest(digest),
});
export const submit = async (
  stack: Stack,
  event: EventEnvelope,
  operationId: string = event.eventId,
  mode: "follow-up" | "steer" | "replace" = "follow-up"
): Promise<SessionReceipt> =>
  await request(stack, "/runtime/submit", {
    address: event,
    command: { event, mode, type: "submit" },
    options: effectOptions(operationId),
  });
export const inspect = async (
  stack: Stack,
  address: EventAddress,
  principal?: string
): Promise<DomainSnapshot> =>
  Schema.decodeUnknownSync(DomainSnapshot)(
    await request(
      stack,
      "/runtime/inspect",
      { address, options: effectOptions(`inspect:${randomUUID()}`) },
      principal
    )
  );
export const pending = async (
  stack: Stack,
  address: EventAddress
): Promise<ApprovalState> => {
  const snapshot = await waitFor(
    () => inspect(stack, address),
    (value) => value.approvals.some((approval) => approval.state === "pending")
  );
  const approval = snapshot.approvals.find(
    (value) => value.state === "pending"
  );
  assert.ok(approval);
  return approval;
};
export const approve = async (
  stack: Stack,
  address: EventAddress,
  approval: ApprovalState,
  decision: "allow" | "deny" = "allow"
) =>
  await request(stack, "/runtime/approve", {
    address,
    command: {
      address,
      approvalId: approval.approvalId,
      context: fixtureContext(address.organizationId),
      decision,
      runId: approval.runId,
      type: "approve",
    },
    options: effectOptions(`approval:${approval.approvalId}:${decision}`),
  });
export const reconcile = async (
  stack: Stack,
  address: EventAddress,
  approval: ApprovalState
) =>
  await request(stack, "/runtime/reconcile", {
    address,
    command: { operationId: approval.operationId, runId: approval.runId },
    options: effectOptions(`reconcile:${approval.operationId}`),
  });
export const observe = async (stack: Stack, address: EventAddress) => {
  const abort = new AbortController();
  const response = await fetch(
    `http://127.0.0.1:${stack.apiPort}/runtime/stream`,
    {
      body: JSON.stringify({
        address,
        options: effectOptions(`observe:${randomUUID()}`),
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
    }
  );
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    close: async () => {
      await reader.cancel();
      abort.abort();
    },
    next: async (): Promise<Observation> => {
      while (!buffered.includes("\n")) {
        const result = await reader.read();
        assert.equal(
          result.done,
          false,
          "Observation closed before a complete frame"
        );
        buffered += decoder.decode(result.value, { stream: true });
      }
      const index = buffered.indexOf("\n");
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      return Schema.decodeUnknownSync(Observation)(JSON.parse(line));
    },
  };
};
export const evidence = async (
  stack: Stack,
  name: string,
  value: unknown
): Promise<void> => {
  const directory = `/tmp/cerebro-native-host-evidence/${stack.project}`;
  const source = sourceForStack(stack);
  await mkdir(directory, { recursive: true });
  const metadata = compose(stack, ["ps", "--all", "--format", "json"]);
  const versions = compose(stack, [
    "exec",
    "-T",
    "fixture",
    "node",
    "--input-type=module",
    "-e",
    `import { readFileSync } from 'node:fs'; const versions={node:process.version}; for(const name of ['agents','@earendil-works/pi-ai','@earendil-works/pi-durable','effect']) { const value=JSON.parse(readFileSync('node_modules/'+name+'/package.json','utf8')); versions[name]=value.version; } process.stdout.write(JSON.stringify(versions));`,
  ]);
  await writeFile(
    `${directory}/${name}.json`,
    `${JSON.stringify({ dirtyCheckout: source.dirtyCheckout, metadata, sourceIdentity: source.identity, stack, value, versions: JSON.parse(versions) }, null, 2)}\n`
  );
};
