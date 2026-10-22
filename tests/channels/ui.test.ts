/* oxlint-disable no-await-in-loop -- Browser observation tests wait for serial lifecycle transitions. */
import { afterEach, beforeEach, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import {
  agentEditorValues,
  agentExecutionGrants,
} from "../../apps/web/src/features/product/configuration";
import { operationFor } from "../../apps/web/src/features/product/intent";
import type { OperationIntent } from "../../apps/web/src/features/product/intent";
import { createObservationClient } from "../../apps/web/src/features/product/observation";
import type { AgentDetail } from "../../apps/web/src/features/product/types";

mock.module("../../apps/web/src/env.public", () => ({
  ENV: { VITE_SERVER_URL: "http://fixture.invalid" },
}));
const {
  cacheKey,
  clearProductCache,
  currentAccessGeneration,
  mutate,
  request,
} = await import("../../apps/web/src/features/product/api");
const { pendingChatSchema } =
  await import("../../apps/web/src/features/product/chat");

class MemoryStorage {
  private readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const originalGlobals = ["fetch", "sessionStorage", "window"].map((name) => ({
  descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
  name,
}));
let storage = new MemoryStorage();
let browser = new EventTarget();
const installFetch = (
  fetcher: (input: RequestInfo | URL) => Response | Promise<Response>
): void => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: RequestInfo | URL) => Promise.resolve(fetcher(input)),
    writable: true,
  });
};
beforeEach(() => {
  storage = new MemoryStorage();
  browser = new EventTarget();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: storage,
    writable: true,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: browser,
    writable: true,
  });
  installFetch(() => Promise.reject(new Error("Unexpected test fetch.")));
});
afterEach(() => {
  for (const { descriptor, name } of originalGlobals) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
});

const sourceSchema = z.object({ text: z.string() });
const pendingKey = cacheKey("user", "conversation", "pending");
const forbidden = (): Response =>
  Response.json({ message: "Access denied." }, { status: 403 });
const delayedJson = () => {
  const stream = new TransformStream<Uint8Array>();
  const writer = stream.writable.getWriter();
  return {
    finish: async (body: unknown): Promise<void> => {
      await writer.write(new TextEncoder().encode(JSON.stringify(body)));
      await writer.close();
    },
    response: new Response(stream.readable, {
      headers: { "Content-Type": "application/json" },
    }),
  };
};
const accessChanged = {
  message: "Access changed while the request was pending.",
  name: "ProductError",
  status: 403,
};

test("resource denial rejects delayed source and agent responses and clears private cache", async () => {
  const source = delayedJson();
  const agent = delayedJson();
  let cleared = 0;
  browser.addEventListener("cerebro:access-cleared", () => {
    cleared += 1;
  });
  storage.setItem(pendingKey, "private pending message");
  storage.setItem("unrelated", "keep");
  installFetch((input) => {
    const url = String(input);
    if (url.endsWith("/source")) {
      return source.response;
    }
    if (url.endsWith("/agent")) {
      return agent.response;
    }
    return forbidden();
  });
  const staleSource = assert.rejects(
    request("/source", sourceSchema),
    accessChanged
  );
  const staleAgent = assert.rejects(
    request("/agent", sourceSchema),
    accessChanged
  );
  await assert.rejects(request("/resource", sourceSchema), { status: 403 });
  await Promise.all([
    source.finish({ text: "private source" }),
    agent.finish({ text: "private agent" }),
  ]);
  await Promise.all([staleSource, staleAgent]);
  assert.equal(cleared, 1);
  assert.equal(storage.getItem(pendingKey), null);
  assert.equal(storage.getItem("unrelated"), "keep");
});

test("logout rejects delayed reads and mutations but permits fresh authorized responses", async () => {
  const source = delayedJson();
  const mutation = delayedJson();
  installFetch((input) => {
    if (String(input).endsWith("/source")) {
      return source.response;
    }
    if (String(input).endsWith("/mutation")) {
      return mutation.response;
    }
    return Response.json({ text: "fresh authorized source" });
  });
  const staleSource = assert.rejects(
    request("/source", sourceSchema),
    accessChanged
  );
  const staleMutation = assert.rejects(
    mutate("/mutation", { operationId: "saved-intent" }, sourceSchema),
    accessChanged
  );
  await delay(0);
  clearProductCache();
  await Promise.all([
    source.finish({ text: "private source" }),
    mutation.finish({ text: "private mutation" }),
  ]);
  await Promise.all([staleSource, staleMutation]);
  assert.deepEqual(await request("/fresh", sourceSchema), {
    text: "fresh authorized source",
  });
});

test("an old HTTP denial cannot clear the current access generation or its draft", async () => {
  const response = Promise.withResolvers<Response>();
  installFetch(() => response.promise);
  const oldRequest = assert.rejects(
    request("/old/resource", sourceSchema),
    accessChanged
  );
  clearProductCache();
  const generation = currentAccessGeneration();
  storage.setItem(pendingKey, "current private draft");
  response.resolve(forbidden());
  await oldRequest;
  assert.equal(currentAccessGeneration(), generation);
  assert.equal(storage.getItem(pendingKey), "current private draft");
});

test("unauthenticated requests clear private state", async () => {
  storage.setItem(pendingKey, "private pending message");
  installFetch(() => Response.json({ message: "Sign in." }, { status: 401 }));
  await assert.rejects(request("/resource", sourceSchema), { status: 401 });
  assert.equal(storage.getItem(pendingKey), null);
});

const { readObservations, submitMessage, stopConversation, decideApproval } =
  await import("../../apps/web/src/features/product/chat-connection");
const {
  MAX_OBSERVATION_FRAME_BYTES,
  OBSERVATION_CONTENT_TYPE,
  ObservationProtocolError,
  decodeObservation,
} = await import("../../apps/web/src/features/product/observation");
const emptyObservation = () =>
  decodeObservation({
    snapshot: {
      address: {
        agentId: "agent",
        conversationId: "conversation",
        organizationId: "company",
        sessionId: "session",
      },
      agentVersion: 1,
      queuedInputs: [],
      tools: [],
      approvals: [],
      busy: false,
      messages: [],
    },
    type: "snapshot",
  });
const ndjson = (frames: unknown[]) =>
  new Response(
    `${frames.map((frame) => JSON.stringify(decodeObservation(frame))).join("\n")}\n`,
    { headers: { "Content-Type": OBSERVATION_CONTENT_TYPE } }
  );
const waitForObservation = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  assert.fail("Browser observation did not settle.");
};

test("an authorized observation reads the full native snapshot without protocol cursors", async () => {
  const paths: string[] = [];
  installFetch((input) => {
    paths.push(String(input));
    return ndjson([emptyObservation()]);
  });
  const values = await Array.fromAsync(
    readObservations(
      "/conversation",
      currentAccessGeneration(),
      new AbortController().signal
    )
  );
  assert.deepEqual(values, [emptyObservation()]);
  assert.deepEqual(paths, ["http://fixture.invalid/conversation/observations"]);
});

for (const role of ["assistant", "tool"] as const) {
  test(`a snapshot near the frame byte limit preserves ${role} text`, async () => {
    const initial = emptyObservation();
    assert.equal(initial.type, "snapshot");
    if (initial.type !== "snapshot") {
      assert.fail("Expected snapshot");
    }
    const build = (text: string) =>
      decodeObservation({
        ...initial,
        snapshot: {
          ...initial.snapshot,
          messages: [{ id: "native-entry", role, state: "complete", text }],
        },
      });
    const overhead = new TextEncoder().encode(JSON.stringify(build(""))).length;
    const text = "A".repeat(MAX_OBSERVATION_FRAME_BYTES - overhead - 16);
    const observation = build(text);
    const bytes = new TextEncoder().encode(JSON.stringify(observation)).length;
    assert.ok(bytes < MAX_OBSERVATION_FRAME_BYTES);
    assert.ok(bytes > MAX_OBSERVATION_FRAME_BYTES - 32);
    installFetch(() => ndjson([observation]));
    const values = await Array.fromAsync(
      readObservations(
        "/conversation",
        currentAccessGeneration(),
        new AbortController().signal
      )
    );
    const received = decodeObservation(values[0]);
    assert.equal(received.type, "snapshot");
    if (received.type === "snapshot") {
      assert.equal(received.snapshot.messages[0]?.text, text);
    }
  });
}

test("the browser rejects frames by UTF-8 byte size", async () => {
  const content = JSON.stringify({
    delta: "é".repeat(MAX_OBSERVATION_FRAME_BYTES / 2),
  });
  assert.ok(content.length < MAX_OBSERVATION_FRAME_BYTES);
  installFetch(
    () =>
      new Response(`${content}\n`, {
        headers: { "Content-Type": OBSERVATION_CONTENT_TYPE },
      })
  );
  await assert.rejects(
    Array.fromAsync(
      readObservations(
        "/conversation",
        currentAccessGeneration(),
        new AbortController().signal
      )
    ),
    /transport limit/u
  );
});

test("observation rejects stale access while response headers are pending", async () => {
  const response = Promise.withResolvers<Response>();
  installFetch(() => response.promise);
  const iterator = readObservations(
    "/conversation",
    currentAccessGeneration(),
    new AbortController().signal
  )[Symbol.asyncIterator]();
  const next = assert.rejects(iterator.next(), { status: 403 });
  clearProductCache();
  response.resolve(ndjson([emptyObservation()]));
  await next;
});

test("HTTP observation denial clears private cache and protected snapshots", async () => {
  storage.setItem(pendingKey, "private pending message");
  installFetch(() => forbidden());
  const initial = emptyObservation();
  if (initial.type !== "snapshot") {
    assert.fail("Expected snapshot");
  }
  const observer = createObservationClient({
    address: initial.snapshot.address,
    generation: currentAccessGeneration,
    onDenied: clearProductCache,
    onSnapshot: () => {},
    open: (generation, signal) =>
      readObservations("/conversation", generation, signal),
  });
  try {
    observer.attach();
    await waitForObservation(() => storage.getItem(pendingKey) === null);
    assert.equal(observer.getSnapshot(), null);
  } finally {
    observer.dispose();
  }
});

const checkRetiredHttpObservation = async (
  retirement: "reattach" | "dispose" | "generation"
) => {
  const response = Promise.withResolvers<Response>();
  let fetches = 0;
  let denials = 0;
  installFetch(() => {
    fetches += 1;
    return fetches === 1 ? response.promise : ndjson([emptyObservation()]);
  });
  const initial = emptyObservation();
  if (initial.type !== "snapshot") {
    assert.fail("Expected snapshot");
  }
  const observer = createObservationClient({
    address: initial.snapshot.address,
    generation: currentAccessGeneration,
    onDenied: () => {
      denials += 1;
      clearProductCache();
    },
    onSnapshot: () => {},
    open: (generation, signal) =>
      readObservations("/conversation", generation, signal),
    retryDelayMs: 1000,
  });
  try {
    observer.attach();
    await delay(0);
    if (retirement === "generation") {
      clearProductCache();
    } else if (retirement === "dispose") {
      observer.dispose();
    } else {
      observer.detach();
      observer.attach();
    }
    const generation = currentAccessGeneration();
    storage.setItem(pendingKey, "current private message");
    response.resolve(forbidden());
    await delay(30);
    assert.equal(denials, 0);
    assert.equal(currentAccessGeneration(), generation);
    assert.equal(storage.getItem(pendingKey), "current private message");
    if (retirement === "reattach") {
      assert.equal(fetches, 2);
      assert.ok(observer.getSnapshot());
    }
  } finally {
    response.resolve(forbidden());
    observer.dispose();
  }
};
for (const retirement of ["reattach", "dispose", "generation"] as const) {
  test(`a detached HTTP observation after ${retirement} cannot clear current browser caches`, () =>
    checkRetiredHttpObservation(retirement));
}

test("the observation reader rejects a truncated frame and releases the stream", async () => {
  installFetch(
    () =>
      new Response('{"unfinished":', {
        headers: { "Content-Type": OBSERVATION_CONTENT_TYPE },
      })
  );
  await assert.rejects(
    Array.fromAsync(
      readObservations(
        "/conversation",
        currentAccessGeneration(),
        new AbortController().signal
      )
    ),
    /inside a frame/u
  );
});

test("native send retries retain the operation ID and Stop and approval use their native commands", async () => {
  const requests: { url: string; body: unknown }[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: RequestInfo | URL, init: RequestInit) => {
      const url = String(input);
      requests.push({ body: JSON.parse(String(init.body)), url });
      if (url.endsWith("/messages")) {
        return Promise.resolve(
          Response.json({
            receipt: {
              accepted: true,
              operationId: "operation",
              session: "session",
            },
          })
        );
      }
      if (url.endsWith("/stop")) {
        return Promise.resolve(Response.json({ stopped: true }));
      }
      return Promise.resolve(
        Response.json({
          approval: {
            approvalId: "approval",
            arguments: {},
            callId: "native-call",
            expiresAt: 60_000,
            operationId: "tool-operation",
            state: "allowed",
            taskId: "native-task",
            toolId: "write-ticket",
          },
        })
      );
    },
    writable: true,
  });
  const message = pendingChatSchema.parse({
    operationId: "operation",
    text: "Draft",
  });
  await submitMessage("/conversation", message);
  await submitMessage("/conversation", message);
  await decideApproval("/conversation", "approval", "allow");
  await stopConversation("/conversation");
  assert.deepEqual(requests, [
    {
      body: { operationId: "operation", text: "Draft" },
      url: "http://fixture.invalid/conversation/messages",
    },
    {
      body: { operationId: "operation", text: "Draft" },
      url: "http://fixture.invalid/conversation/messages",
    },
    {
      body: { decision: "allow" },
      url: "http://fixture.invalid/conversation/approvals/approval",
    },
    { body: {}, url: "http://fixture.invalid/conversation/stop" },
  ]);
});

/* eslint-disable sort-keys -- These inputs deliberately change key order to test canonical retries. */
test("operation intent remains stable for canonical retries and changes for new input or reset", () => {
  const intent: { current: OperationIntent | null } = { current: null };
  const first = operationFor(intent, {
    grants: [{ action: "read", principalId: "person" }],
    name: "Agent",
  });
  assert.match(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  );
  assert.equal(
    operationFor(intent, {
      name: "Agent",
      grants: [{ principalId: "person", action: "read" }],
      omitted: undefined,
    }),
    first
  );
  const changed = operationFor(intent, {
    grants: [{ action: "read", principalId: "person" }],
    name: "Other agent",
  });
  assert.notEqual(changed, first);
  assert.equal(
    operationFor(intent, {
      name: "Other agent",
      grants: [{ principalId: "person", action: "read" }],
    }),
    changed
  );
  intent.current = null;
  const reset = operationFor(intent, {
    name: "Other agent",
    grants: [{ action: "read", principalId: "person" }],
  });
  assert.notEqual(reset, changed);
  assert.equal(
    operationFor(intent, {
      name: "Other agent",
      grants: [{ action: "read", principalId: "person" }],
    }),
    reset
  );
});

/* eslint-enable sort-keys */

test("explicit agent selections publish tool read/execute and source read grants", () => {
  assert.deepEqual(
    agentExecutionGrants("company", ["read-policy"], ["travel-source"]),
    [
      {
        action: "read",
        resource: {
          id: "read-policy",
          kind: "tool",
          organizationId: "company",
        },
      },
      {
        action: "execute",
        resource: {
          id: "read-policy",
          kind: "tool",
          organizationId: "company",
        },
      },
      {
        action: "read",
        resource: {
          id: "travel-source",
          kind: "memory",
          organizationId: "company",
        },
      },
    ]
  );
  assert.deepEqual(agentExecutionGrants("company", [], []), []);
});

test("selected configured tools publish only their explicit connector execution grants", () => {
  const grants = agentExecutionGrants(
    "company",
    ["read-policy", "read-directory"],
    [],
    [],
    [
      { connectorId: "company-connector", id: "read-policy" },
      { connectorId: "company-connector", id: "read-directory" },
      { connectorId: "other-connector", id: "unselected" },
    ]
  );
  assert.deepEqual(grants, [
    {
      action: "read",
      resource: { id: "read-policy", kind: "tool", organizationId: "company" },
    },
    {
      action: "execute",
      resource: { id: "read-policy", kind: "tool", organizationId: "company" },
    },
    {
      action: "read",
      resource: {
        id: "read-directory",
        kind: "tool",
        organizationId: "company",
      },
    },
    {
      action: "execute",
      resource: {
        id: "read-directory",
        kind: "tool",
        organizationId: "company",
      },
    },
    {
      action: "execute",
      resource: {
        id: "company-connector",
        kind: "tool",
        organizationId: "company",
      },
    },
  ]);
});

const obsoleteAgent: AgentDetail = {
  access: [],
  agentId: "company-assistant",
  connectorChoices: [],
  definition: {
    agentId: "company-assistant",
    enabledToolIds: ["fixture-read"],
    grants: [
      {
        action: "read",
        resource: {
          id: "old-source",
          kind: "memory",
          organizationId: "company",
        },
      },
    ],
    instructions: "Answer company questions.",
    model: "fixture-model",
    organizationId: "company",
    version: 1,
  },
  modelChoices: [{ id: "fixture/configured-model", label: "Space Bunny Free" }],
  name: "Company assistant",
  sourceChoices: [],
};

test("agent editor replaces obsolete fixture choices with the current catalog", () => {
  const agent = structuredClone(obsoleteAgent);
  const original = structuredClone(agent);
  assert.deepEqual(agentEditorValues(agent), {
    catalog: {
      connectorChoices: [],
      modelChoices: [
        { id: "fixture/configured-model", label: "Space Bunny Free" },
      ],
      sourceChoices: [],
    },
    instructions: "Answer company questions.",
    model: "fixture/configured-model",
    name: "Company assistant",
    sourceIds: [],
    toolIds: [],
    unavailableSelections: {
      model: "fixture-model",
      sourceIds: ["old-source"],
      toolIds: ["fixture-read"],
    },
  });
  assert.deepEqual(agent, original);
});

test("agent editor preserves a valid nonfirst model and filters mixed tool and source IDs", () => {
  const agent: AgentDetail = {
    ...structuredClone(obsoleteAgent),
    connectorChoices: [{ id: "read-policy", label: "Read policy" }],
    definition: {
      ...structuredClone(obsoleteAgent.definition),
      enabledToolIds: ["fixture-read", "read-policy"],
      grants: [
        ...structuredClone(obsoleteAgent.definition.grants),
        {
          action: "read",
          resource: {
            id: "travel-source",
            kind: "memory",
            organizationId: "company",
          },
        },
      ],
      model: "company/model",
    },
    modelChoices: [
      { id: "fixture/configured-model", label: "Space Bunny Free" },
      { id: "company/model", label: "Company model" },
    ],
    sourceChoices: [{ id: "travel-source", label: "Travel policy" }],
  };
  const original = structuredClone(agent);
  const draft = agentEditorValues(agent);
  assert.deepEqual(
    {
      model: draft.model,
      sourceIds: draft.sourceIds,
      toolIds: draft.toolIds,
      unavailableSelections: draft.unavailableSelections,
    },
    {
      model: "company/model",
      sourceIds: ["travel-source"],
      toolIds: ["read-policy"],
      unavailableSelections: {
        model: null,
        sourceIds: ["old-source"],
        toolIds: ["fixture-read"],
      },
    }
  );
  assert.deepEqual(agent, original);
});

test("agent editor leaves the model empty when no configured model is available", () => {
  const draft = agentEditorValues({
    ...structuredClone(obsoleteAgent),
    modelChoices: [],
  });
  assert.deepEqual(
    { model: draft.model, unavailableSelections: draft.unavailableSelections },
    {
      model: "",
      unavailableSelections: {
        model: "fixture-model",
        sourceIds: ["old-source"],
        toolIds: ["fixture-read"],
      },
    }
  );
});

for (const invalid of ["content-type", "json"] as const) {
  test(`${invalid} violations are terminal observation errors`, async () => {
    installFetch(
      () =>
        new Response(invalid === "json" ? "not json\n" : "{}\n", {
          headers: {
            "Content-Type":
              invalid === "json" ? OBSERVATION_CONTENT_TYPE : "text/plain",
          },
        })
    );
    await assert.rejects(
      Array.fromAsync(
        readObservations(
          "/conversation",
          currentAccessGeneration(),
          new AbortController().signal
        )
      ),
      (error: unknown) => {
        assert.equal(error instanceof ObservationProtocolError, true);
        assert.match(
          String(error),
          invalid === "json" ? /not valid JSON/u : /must return NDJSON/u
        );
        return true;
      }
    );
  });
}
