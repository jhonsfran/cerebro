import { afterEach, beforeEach, mock, test } from "bun:test";
import assert from "node:assert/strict";

import { z } from "zod";

import { agentExecutionGrants } from "../../apps/web/src/features/product/configuration";
import { operationFor } from "../../apps/web/src/features/product/intent";
import type { OperationIntent } from "../../apps/web/src/features/product/intent";
import type { ConversationItem } from "../../apps/web/src/features/product/types";

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
const { readConversationStream } =
  await import("../../apps/web/src/features/product/stream");

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

test("stale streams emit no records and fresh streams emit validated records", async () => {
  const stream = new TransformStream<Uint8Array>();
  const writer = stream.writable.getWriter();
  const connected = Promise.withResolvers<null>();
  const signal = new AbortController();
  const received: ConversationItem[] = [];
  installFetch(() => new Response(stream.readable));
  const oldStream = readConversationStream(
    "/conversation",
    "0",
    signal.signal,
    (item) => received.push(item),
    () => connected.resolve(null)
  );
  const stale = assert.rejects(oldStream, accessChanged);
  await connected.promise;
  clearProductCache();
  const item = {
    cursor: "1",
    runId: "run",
    text: "private output",
    type: "output",
  };
  await writer.write(
    new TextEncoder().encode(`event: item\ndata: ${JSON.stringify(item)}\n\n`)
  );
  await stale;
  signal.abort();
  await writer.close();
  assert.deepEqual(received, []);

  installFetch(
    () => new Response(`event: item\ndata: ${JSON.stringify(item)}\n\n`)
  );
  const freshSignal = new AbortController();
  await readConversationStream(
    "/conversation",
    "0",
    freshSignal.signal,
    (record) => {
      received.push(record);
      freshSignal.abort();
    },
    () => {}
  );
  assert.deepEqual(received, [
    { cursor: "1", runId: "run", text: "private output", type: "output" },
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
