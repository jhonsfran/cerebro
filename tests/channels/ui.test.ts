import { afterEach, beforeEach, mock, test } from "bun:test";
import assert from "node:assert/strict";

import { z } from "zod";

import {
  agentEditorValues,
  agentExecutionGrants,
} from "../../apps/web/src/features/product/configuration";
import { operationFor } from "../../apps/web/src/features/product/intent";
import type { OperationIntent } from "../../apps/web/src/features/product/intent";
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
const { conversationItems, loadChatMessages, messageText } =
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

test("optional budget denial retains pending messages and permitted concurrent responses", async () => {
  const source = delayedJson();
  let cleared = 0;
  browser.addEventListener("cerebro:access-cleared", () => {
    cleared += 1;
  });
  storage.setItem(pendingKey, "private pending message");
  const generation = currentAccessGeneration();
  installFetch((input) =>
    String(input).endsWith("/source") ? source.response : forbidden()
  );
  const permittedSource = request("/source", sourceSchema);
  await assert.rejects(
    request("/api/product/budget", sourceSchema, undefined, "optional-budget"),
    { status: 403 }
  );
  await source.finish({ text: "permitted source" });
  assert.deepEqual(await permittedSource, { text: "permitted source" });
  assert.equal(storage.getItem(pendingKey), "private pending message");
  assert.equal(currentAccessGeneration(), generation);
  assert.equal(cleared, 0);
  await assert.rejects(
    request("/resource", sourceSchema, undefined, "optional-budget"),
    { status: 403 }
  );
  assert.equal(storage.getItem(pendingKey), null);
  assert.equal(cleared, 1);
});

test("unauthenticated optional budget requests still clear private state", async () => {
  storage.setItem(pendingKey, "private pending message");
  installFetch(() => Response.json({ message: "Sign in." }, { status: 401 }));
  await assert.rejects(
    request("/api/product/budget", sourceSchema, undefined, "optional-budget"),
    { status: 401 }
  );
  assert.equal(storage.getItem(pendingKey), null);
});

test("a new SDK chat loads an empty transcript", async () => {
  installFetch(() => Response.json([]));
  assert.deepEqual(
    await loadChatMessages({ url: "http://fixture.invalid/conversation/chat" }),
    []
  );
});

test("SDK chat history cannot expose a stale response after access changes", async () => {
  const history = delayedJson();
  installFetch(() => history.response);
  const oldHistory = loadChatMessages({
    url: "http://fixture.invalid/conversation/chat",
  });
  clearProductCache();
  await history.finish([
    {
      id: "assistant:run",
      parts: [{ text: "private output", type: "text" }],
      role: "assistant",
    },
  ]);
  assert.deepEqual(await oldHistory, []);
});

test("SDK chat history clears private cache on denied access", async () => {
  storage.setItem(pendingKey, "private pending message");
  installFetch(() => forbidden());
  assert.deepEqual(
    await loadChatMessages({ url: "http://fixture.invalid/conversation/chat" }),
    []
  );
  assert.equal(storage.getItem(pendingKey), null);
});

test("SDK chat parts preserve text and deduplicate execution records by domain identity", async () => {
  installFetch(() =>
    Response.json([
      {
        id: "assistant:run",
        parts: [
          { text: "Live ", type: "text" },
          { text: "response", type: "text" },
          {
            data: {
              cursor: "2",
              run: { runId: "run", state: "completed" },
              type: "run",
            },
            type: "data-conversation-item",
          },
        ],
        role: "assistant",
      },
    ])
  );
  const messages = await loadChatMessages({
    url: "http://fixture.invalid/conversation/chat",
  });
  const [first] = messages;
  assert.ok(first);
  assert.equal(messageText(first), "Live response");
  assert.deepEqual(
    conversationItems(messages, [
      { cursor: "1", eventId: "event", text: "Hello", type: "user" },
      {
        cursor: "projection:2",
        run: { runId: "run", state: "running" },
        type: "run",
      },
    ]),
    [
      { cursor: "1", eventId: "event", text: "Hello", type: "user" },
      { cursor: "2", run: { runId: "run", state: "completed" }, type: "run" },
    ]
  );
});

test("SDK replay cannot replace a settled run with an earlier state", () => {
  assert.deepEqual(
    conversationItems(
      [
        {
          id: "assistant:run",
          parts: [
            {
              data: {
                cursor: "session:2",
                run: { runId: "run", state: "running" },
                type: "run",
              },
              type: "data-conversation-item",
            },
          ],
          role: "assistant",
        },
      ],
      [{ cursor: "10", run: { runId: "run", state: "completed" }, type: "run" }]
    ),
    [{ cursor: "10", run: { runId: "run", state: "completed" }, type: "run" }]
  );
});

test("settled output replaces streamed assistant steps with the canonical answer", () => {
  assert.equal(
    messageText({
      id: "assistant:run",
      parts: [
        { text: "I will check. ", type: "text" },
        { text: "Streamed draft answer.", type: "text" },
        {
          data: {
            cursor: "session:8",
            runId: "run",
            text: "Verified final answer.",
            type: "output",
          },
          type: "data-conversation-item",
        },
      ],
      role: "assistant",
    }),
    "Verified final answer."
  );
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
  modelChoices: [
    { id: "opencode/space-bunny-free", label: "Space Bunny Free" },
  ],
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
        { id: "opencode/space-bunny-free", label: "Space Bunny Free" },
      ],
      sourceChoices: [],
    },
    instructions: "Answer company questions.",
    model: "opencode/space-bunny-free",
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
      { id: "opencode/space-bunny-free", label: "Space Bunny Free" },
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
