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

import type { EventAddress } from "../../packages/contracts/src/events.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type { ExecutionContext } from "../../packages/contracts/src/identity.ts";
import type {
  ChatApproval,
  ChatControl as ChatControlValue,
} from "../../packages/contracts/src/session-service.ts";
import {
  ChatControlReceipt,
  ChatDecisionReceipt,
  ChatForkReceipt,
  ChatObservation,
  ChatReceipt,
  ChatSnapshot,
} from "../../packages/contracts/src/session-service.ts";

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
    "packages/generative-ui/src",
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
export const request = async (
  stack: Stack,
  path: string,
  body: unknown,
  principal?: string
): Promise<unknown> => {
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
  return result.value;
};
// Docker Desktop can refuse a published port for a moment after a container signal.
export const getFixture = async (
  stack: Stack,
  path = "/observations"
): Promise<unknown> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${stack.fixturePort}${path}`,
        { signal: AbortSignal.timeout(10_000) }
      );
      assert.equal(response.status, 200);
      return await response.json();
    } catch (error) {
      if (!(error instanceof TypeError) || attempt === 4) {
        throw error;
      }
      await delay(500);
    }
  }
};
const providerSchema = Schema.Struct({
  checkpoints: Schema.Array(
    Schema.Struct({
      armed: Schema.optional(Schema.Boolean),
      boundary: Schema.String,
      operationId: Schema.String,
    })
  ),
  fixtureId: Schema.String,
  held: Schema.Number,
  model: Schema.Array(
    Schema.Struct({
      completedAt: Schema.optional(Schema.Number),
      operationId: Schema.String,
      startedAt: Schema.Number,
      status: Schema.optional(Schema.Number),
    })
  ),
  revision: Schema.Number,
  sha: Schema.String,
  tools: Schema.Array(
    Schema.Struct({
      completedAt: Schema.optional(Schema.Number),
      operationId: Schema.String,
      receipt: Schema.String,
      write: Schema.Boolean,
    })
  ),
});
export type ProviderEvidence = typeof providerSchema.Type;
export const provider = async (stack: Stack): Promise<ProviderEvidence> =>
  Schema.decodeUnknownSync(providerSchema)(await getFixture(stack));
export const control = async (stack: Stack, input: unknown): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${stack.fixturePort}/control`,
        {
          body: JSON.stringify(input),
          headers: {
            "Content-Type": "application/json",
            "x-fixture-control": "slice-1-control",
          },
          method: "POST",
          signal: AbortSignal.timeout(10_000),
        }
      );
      assert.equal(response.status, 200);
      return;
    } catch (error) {
      if (!(error instanceof TypeError) || attempt === 4) {
        throw error;
      }
      await delay(500);
    }
  }
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
  conversationId: string,
  agentId = "agent-1"
): EventAddress => ({
  agentId: id.agent(agentId),
  conversationId: id.conversation(conversationId),
  organizationId: id.organization(organizationId),
  sessionId: id.session(
    `session:${organizationId}:${agentId}:${conversationId}`
  ),
});
export const send = async (
  stack: Stack,
  address: EventAddress,
  operationId: string,
  text: string
): Promise<ChatReceipt> => {
  const value = await request(stack, "/runtime/send", {
    address,
    operationId,
    text,
  });
  try {
    return Schema.decodeUnknownSync(ChatReceipt)(value);
  } catch (error) {
    throw new Error(`Invalid chat receipt: ${JSON.stringify(value)}`, {
      cause: error,
    });
  }
};
export const read = async (
  stack: Stack,
  address: EventAddress,
  principal?: string
): Promise<ChatSnapshot> =>
  Schema.decodeUnknownSync(ChatSnapshot)(
    await request(stack, "/runtime/read", { address }, principal)
  );
export const stop = async (stack: Stack, address: EventAddress) =>
  Schema.decodeUnknownSync(Schema.Struct({ stopped: Schema.Boolean }))(
    await request(stack, "/runtime/stop", { address })
  );
export const chatControl = async (
  stack: Stack,
  address: EventAddress,
  command: ChatControlValue
) =>
  Schema.decodeUnknownSync(ChatControlReceipt)(
    await request(stack, "/runtime/control", { address, command })
  );
export const reserveFork = async (
  stack: Stack,
  destination: EventAddress,
  source: EventAddress,
  entryId: string,
  agentVersion: number
): Promise<void> => {
  await request(stack, "/runtime/fixture/capabilities/reserve-fork", {
    address: destination,
    origin: { address: source, agentVersion, entryId },
  });
};
export const fork = async (
  stack: Stack,
  address: EventAddress,
  destination: EventAddress,
  entryId: string,
  operationId: string
) =>
  Schema.decodeUnknownSync(ChatForkReceipt)(
    await request(stack, "/runtime/fork", {
      address,
      destination,
      entryId,
      operationId,
    })
  );
export const capabilityProvider = async (stack: Stack) =>
  Schema.decodeUnknownSync(
    Schema.Struct({
      model: Schema.Array(
        Schema.Struct({
          operationId: Schema.String,
          prompt: Schema.String,
          purpose: Schema.Literals(["turn", "compaction"]),
          scope: Schema.String,
          startedAt: Schema.Number,
          completedAt: Schema.optional(Schema.Number),
          toolNames: Schema.Array(Schema.String),
        })
      ),
    })
  )(await getFixture(stack, "/capabilities/observations"));
export const capabilityStorage = async (stack: Stack, address: EventAddress) =>
  Schema.decodeUnknownSync(
    Schema.Struct({
      conversations: Schema.Array(
        Schema.Struct({
          id: Schema.Number,
          ownerConversationId: Schema.NullOr(Schema.Number),
          ownerTaskId: Schema.NullOr(Schema.Number),
          parentConversationId: Schema.NullOr(Schema.Number),
          parentEntryId: Schema.NullOr(Schema.Number),
        })
      ),
      submissions: Schema.Array(
        Schema.Struct({
          id: Schema.Number,
          conversationId: Schema.Number,
          requestId: Schema.NullOr(Schema.String),
          status: Schema.String,
        })
      ),
      tasks: Schema.Array(
        Schema.Struct({
          id: Schema.Number,
          conversationId: Schema.Number,
          kind: Schema.String,
          status: Schema.String,
        })
      ),
    })
  )(await request(stack, "/runtime/fixture/capabilities/storage", { address }));
export const pending = async (
  stack: Stack,
  address: EventAddress
): Promise<ChatApproval> => {
  const snapshot = await waitFor(
    () => read(stack, address),
    (value) => value.approvals.some((approval) => approval.state === "pending")
  );
  const approval = snapshot.approvals.find(
    (value) => value.state === "pending"
  );
  assert.ok(approval);
  return approval;
};
export const decide = async (
  stack: Stack,
  address: EventAddress,
  approval: ChatApproval,
  decision: "allow" | "deny" = "allow"
): Promise<ChatDecisionReceipt> =>
  Schema.decodeUnknownSync(ChatDecisionReceipt)(
    await request(stack, "/runtime/decide", {
      address,
      approvalId: approval.approvalId,
      decision,
    })
  );
export const observe = async (stack: Stack, address: EventAddress) => {
  const abort = new AbortController();
  const response = await fetch(
    `http://127.0.0.1:${stack.apiPort}/runtime/observe`,
    {
      body: JSON.stringify({ address }),
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
    next: async (): Promise<ChatObservation> => {
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
      return Schema.decodeUnknownSync(ChatObservation)(JSON.parse(line));
    },
  };
};
export const nativeStorage = async (stack: Stack, address: EventAddress) =>
  Schema.decodeUnknownSync(
    Schema.Struct({
      submissions: Schema.Array(
        Schema.Struct({
          conversation_id: Schema.Number,
          id: Schema.Number,
          request_id: Schema.NullOr(Schema.String),
          status: Schema.String,
        })
      ),
      tables: Schema.Array(Schema.String),
      tasks: Schema.Array(
        Schema.Struct({
          abort_requested: Schema.Number,
          conversation_id: Schema.Number,
          id: Schema.Number,
          kind: Schema.String,
          memos: Schema.NullOr(Schema.String),
          state: Schema.String,
          status: Schema.String,
        })
      ),
    })
  )(await request(stack, "/runtime/fixture/native-storage", { address }));
export const lifecycle = async (stack: Stack, address: EventAddress) =>
  Schema.decodeUnknownSync(
    Schema.Struct({
      alarmAt: Schema.NullOr(Schema.Number),
      alarms: Schema.Array(Schema.Struct({ at: Schema.Number })),
      jobs: Schema.Array(
        Schema.Struct({
          capability: Schema.String,
          execution_started_at: Schema.NullOr(Schema.Number),
          fn: Schema.String,
          id: Schema.String,
          running: Schema.Number,
          time: Schema.Number,
        })
      ),
      pending: Schema.Array(
        Schema.Struct({
          operationId: Schema.String,
          session: Schema.String,
          status: Schema.Literals(["queued", "running"]),
        })
      ),
    })
  )(await request(stack, "/runtime/fixture/lifecycle", { address }));
export const runtimeEvidence = async (
  stack: Stack,
  address: EventAddress,
  ownerPrincipalId?: string
) =>
  Schema.decodeUnknownSync(
    Schema.Struct({
      failures: Schema.Array(
        Schema.Struct({
          committedSeq: Schema.Number,
          instanceId: Schema.String,
          operationId: Schema.String,
        })
      ),
      instanceId: Schema.String,
      nativeSessionId: Schema.String,
      modelRequests: Schema.Array(
        Schema.Struct({
          operationId: Schema.String,
          body: Schema.Struct({
            model: Schema.String,
            messages: Schema.Array(
              Schema.Struct({ role: Schema.String, content: Schema.Unknown })
            ),
            tools: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  function: Schema.Struct({
                    name: Schema.String,
                    description: Schema.String,
                    parameters: Schema.Unknown,
                  }),
                })
              )
            ),
          }),
        })
      ),
      notifications: Schema.Array(ChatSnapshot),
    })
  )(
    await request(stack, "/runtime/fixture/runtime", {
      address,
      ...(ownerPrincipalId ? { ownerPrincipalId } : {}),
    })
  );
export const dependencyCheckpoint = async (
  stack: Stack,
  address: EventAddress,
  state: { readonly armed?: boolean; readonly released?: boolean } = {}
) =>
  Schema.decodeUnknownSync(
    Schema.Struct({
      armed: Schema.Boolean,
      released: Schema.Boolean,
      waiting: Schema.Boolean,
    })
  )(
    await request(stack, "/runtime/fixture/dependency-checkpoint", {
      address,
      ...state,
    })
  );
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
