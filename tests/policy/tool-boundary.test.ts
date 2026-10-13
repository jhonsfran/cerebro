// oxlint-disable unicorn/no-await-expression-member -- Boundary assertions compare the completed contract response directly.
// oxlint-disable eslint/require-await -- Fixture providers answer synchronously behind the async fetch contract.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

import { Effect } from "effect";
import { z } from "zod";

import { discoverMcpTools } from "../../apps/server/src/mcp-discovery.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type { EffectOptions } from "../../packages/contracts/src/port.ts";
import { digestToolArguments } from "../../packages/contracts/src/tools.ts";
import type { ToolCall } from "../../packages/contracts/src/tools.ts";
import {
  connectorAccountId,
  openCredentials,
  sealCredentials,
} from "../../packages/tools/src/accounts.ts";
import { readBoundedJson } from "../../packages/tools/src/bounded-json.ts";
import { createConnectorExecutor } from "../../packages/tools/src/connector.ts";
import type { ConnectorCredentials } from "../../packages/tools/src/connector.ts";
import { listMcpTools } from "../../packages/tools/src/mcp.ts";
import {
  createToolRegistry,
  bindRegisteredTool,
} from "../../packages/tools/src/registry.ts";
import type { ToolRegistration } from "../../packages/tools/src/registry.ts";
import {
  allowedContext,
  fixtureAgentId,
  fixtureOrganizationId,
  fixtureRunId,
} from "../support/fixtures.ts";

const secret = "fixture-secret-for-redaction";
const inputSchema = z.strictObject({ query: z.string() });
const outputSchema = z.strictObject({ text: z.string() });
const registration = (write = false): ToolRegistration => ({
  definition: {
    connectorId: "fixture_connector",
    effect: write ? "write" : "read",
    id: id.tool("fixture_tool"),
    version: "1",
  },
  description: "Controlled fixture tool.",
  input: inputSchema,
  maxInputBytes: 1024,
  maxOutputBytes: 1024,
  normalize(input) {
    const value = inputSchema.parse(input);
    return { query: value.query.trim() };
  },
  output: outputSchema,
  requiresApproval: write,
  retryMode: "at-most-once",
  target: write
    ? {
        kind: "http-write",
        method: "fixture-effect",
        url: "http://fixture.invalid/effect",
      }
    : {
        kind: "mcp",
        method: "fixture-search",
        url: "https://fixture.invalid/mcp",
      },
});
// Answers the MCP handshake the way a server does; tool calls fall through.
const mcpHandshake = (message: {
  readonly id?: number;
  readonly method?: string;
  readonly params?: { readonly protocolVersion?: string };
}): Response | undefined => {
  if (message.method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }
  if (message.method === "initialize") {
    return Response.json({
      id: message.id,
      jsonrpc: "2.0",
      result: {
        capabilities: { tools: {} },
        protocolVersion: message.params?.protocolVersion,
        serverInfo: { name: "fixture", version: "1.0.0" },
      },
    });
  }
  return undefined;
};

const fixture = async (write = false) => {
  const requests: unknown[] = [];
  const state = {
    cancelledStream: false,
    oversized: false,
    posts: 0,
    requests,
    timeout: false,
  };
  const registered = registration(write);
  const registry = createToolRegistry([registered], "local");
  const call: ToolCall = {
    agentId: fixtureAgentId,
    arguments: { query: "  support  " },
    context: allowedContext,
    organizationId: fixtureOrganizationId,
    tool: registered.definition,
  };
  const options: EffectOptions = {
    deadlineAt: Date.now() + 30_000,
    operationId: id.operation(crypto.randomUUID()),
    requestDigest: await digestToolArguments(registry.prepare(call).arguments),
  };
  const providerFetch: typeof fetch = async (_request, init) => {
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const handshake = write ? undefined : mcpHandshake(body);
    if (handshake) {
      return handshake;
    }
    state.posts += 1;
    state.requests.push({
      operationId: new Headers(init?.headers).get("x-cerebro-operation-id"),
      params: write ? body : body.params,
    });
    if (state.timeout) {
      throw new Error("Fixture dropped the provider reply.");
    }
    if (state.oversized) {
      return new Response(
        new ReadableStream({
          cancel() {
            state.cancelledStream = true;
          },
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(1025)));
          },
        }),
        { headers: { "content-type": "application/json" } }
      );
    }
    const output = { text: `support ${secret}` };
    return Response.json(
      write
        ? output
        : {
            id: body.id,
            jsonrpc: "2.0",
            result: {
              content: [{ text: output.text, type: "text" }],
              structuredContent: output,
            },
          }
    );
  };
  const tool = await Effect.runPromise(bindRegisteredTool(registry.list()[0]));
  const credentials: ConnectorCredentials = {
    headers: { Authorization: `Bearer ${secret}` },
    secrets: [secret],
  };
  // Normalize, then dispatch through the real connector executor.
  const invoke = async ({
    fetch = providerFetch,
    withoutCredentials = false,
  }: {
    readonly fetch?: typeof globalThis.fetch;
    readonly withoutCredentials?: boolean;
  } = {}) => {
    const executor = createConnectorExecutor({
      credentials: () =>
        Promise.resolve(withoutCredentials ? undefined : credentials),
      fetch,
      registry,
    });
    const result = await Effect.runPromise(
      Effect.result(
        executor.execute(
          { ...registry.prepare(call), runId: fixtureRunId, tool },
          options
        )
      )
    );
    return result._tag === "Success"
      ? { output: result.success.output, status: "ok" }
      : { status: result.failure._tag };
  };
  return { call, invoke, options, registered, registry, state };
};

test("the connector sends one normalized MCP tools/call and redacts its output", async () => {
  const f = await fixture();
  assert.deepEqual(await f.invoke(), {
    output: { text: "support [redacted]" },
    status: "ok",
  });
  assert.deepEqual(f.state.requests, [
    {
      operationId: f.options.operationId,
      params: { arguments: { query: "support" }, name: "fixture-search" },
    },
  ]);
});

test("sealed connector credentials open only with their key, organization, and account", async () => {
  const credentials = {
    headers: { Authorization: `Bearer ${secret}` },
    secrets: [secret],
  };
  const key = "fixture-account-key-with-at-least-32-characters";
  const scope = {
    accountId: connectorAccountId("fixture_connector"),
    organizationId: "company-a",
  };
  const sealed = await sealCredentials(key, scope, credentials);
  assert.equal(sealed.includes(secret), false);
  assert.deepEqual(await openCredentials(key, scope, sealed), credentials);
  await assert.rejects(
    openCredentials(key, { ...scope, organizationId: "company-b" }, sealed)
  );
  await assert.rejects(
    openCredentials(key, { ...scope, accountId: "connector:other" }, sealed)
  );
  await assert.rejects(openCredentials(`${key}-rotated`, scope, sealed));
});

test("an uncertain write reports UnknownOutcome after one dispatch", async () => {
  const f = await fixture(true);
  f.state.timeout = true;
  assert.deepEqual(await f.invoke(), { status: "UnknownOutcome" });
  assert.equal(f.state.posts, 1);
});

test("missing connector credentials deny before any dispatch", async () => {
  const f = await fixture();
  assert.deepEqual(await f.invoke({ withoutCredentials: true }), {
    status: "Denied",
  });
  assert.equal(f.state.posts, 0);
});

test("a provider stream over the byte limit is cancelled and reported unknown", async () => {
  const f = await fixture(true);
  f.state.oversized = true;
  assert.deepEqual(await f.invoke(), { status: "UnknownOutcome" });
  assert.equal(f.state.cancelledStream, true);
  assert.equal(f.state.posts, 1);
});

test("registry and results reject caller mutation", async () => {
  const f = await fixture();
  Reflect.set(f.registered.target, "url", "https://foreign.invalid/");
  const first = await f.invoke();
  assert.deepEqual(first, {
    output: { text: "support [redacted]" },
    status: "ok",
  });
  Reflect.set(first.output ?? {}, "text", "changed");
  assert.deepEqual(await f.invoke(), {
    output: { text: "support [redacted]" },
    status: "ok",
  });
  assert.equal(
    f.registry.get(f.call.tool.id)?.target.url,
    "https://fixture.invalid/mcp"
  );
  assert.throws(() => createToolRegistry([registration(true)], "production"));
  assert.throws(() =>
    createToolRegistry(
      [{ ...registration(true), requiresApproval: false }],
      "local"
    )
  );
  assert.equal(f.state.posts, 2);
});

test("bound connector fingerprints use normalized configured destinations and connector versions", async () => {
  const original = registration();
  const getTool = async (changes: Partial<ToolRegistration>) => {
    const registry = createToolRegistry(
      [{ ...original, connectorVersion: "connector-v1", ...changes }],
      "local"
    );
    return await Effect.runPromise(bindRegisteredTool(registry.list()[0]));
  };
  const first = await getTool({});
  const equivalent = await getTool({
    target: { ...original.target, url: "HTTPS://FIXTURE.INVALID:443/mcp" },
  });
  const version = await getTool({ connectorVersion: "connector-v2" });
  const destination = await getTool({
    target: { ...original.target, url: "https://fixture.invalid/other" },
  });
  assert.equal(first.connectorFingerprint, equivalent.connectorFingerprint);
  assert.notEqual(first.connectorFingerprint, version.connectorFingerprint);
  assert.notEqual(first.connectorFingerprint, destination.connectorFingerprint);
});

test("write connectors require approval and use HTTPS in production", () => {
  const tool = registration(true);
  assert.throws(() => createToolRegistry([tool], "production"), /HTTPS/u);
  const remote = {
    ...tool,
    target: { ...tool.target, url: "https://remote.example/effects" },
  };
  assert.equal(createToolRegistry([remote], "production").list().length, 1);
  assert.equal(createToolRegistry([tool], "local").list().length, 1);
});

test("connector tools cannot use internal skill tool names", () => {
  for (const name of ["activate_skill", "read_skill_resource"]) {
    const tool = registration();
    assert.throws(
      () =>
        createToolRegistry(
          [{ ...tool, definition: { ...tool.definition, id: id.tool(name) } }],
          "local"
        ),
      /reserved/u
    );
  }
});

test("MCP cancellation interrupts initialization before tools/list", async () => {
  const controller = new AbortController();
  const initialized = Promise.withResolvers<undefined>();
  const requests: string[] = [];
  const pending = listMcpTools({
    url: "https://fixture.invalid/mcp",
    headers: {},
    signal: controller.signal,
    fetch: async (_input, init) => {
      const message = JSON.parse(String(init?.body));
      requests.push(message.method);
      assert.ok(init?.signal);
      initialized.resolve();
      const response = Promise.withResolvers<Response>();
      init.signal.addEventListener(
        "abort",
        () => response.reject(new Error("Interrupted initialization")),
        { once: true }
      );
      return await response.promise;
    },
  });
  await initialized.promise;
  controller.abort();
  await assert.rejects(pending, /Interrupted initialization/u);
  assert.deepEqual(requests, ["initialize"]);
});

test("streamed provider output stops waiting and cancels when the deadline signal aborts", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    })
  );
  const reading = readBoundedJson(response, 1024, controller.signal);
  controller.abort();
  await assert.rejects(reading, { name: "AbortError" });
  assert.equal(cancelled, true);
});

const mcpReply = (rpcId: unknown, text = "fixture-result") => ({
  id: rpcId,
  jsonrpc: "2.0",
  result: {
    content: [{ text, type: "text" }],
    structuredContent: { text },
  },
});

test("a real HTTP MCP server answers through initialize and an SSE tools/call", async () => {
  const f = await fixture();
  const seen: { method: string; operationId: unknown }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf-8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const message = JSON.parse(body);
      seen.push({
        method: message.method,
        operationId: request.headers["x-cerebro-operation-id"],
      });
      const handshake = mcpHandshake(message);
      if (handshake) {
        response.writeHead(handshake.status, {
          "content-type": "application/json",
        });
        void handshake.text().then((text) => response.end(text));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1, progressToken: "p" } })}\n\n`
      );
      response.end(`data: ${JSON.stringify(mcpReply(message.id))}\n\n`);
    });
  });
  try {
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await f.invoke({
      fetch: async (target, init) => {
        assert.equal(String(target), "https://fixture.invalid/mcp");
        return await fetch(`http://127.0.0.1:${address.port}/mcp`, init);
      },
    });
    assert.deepEqual(result, {
      output: { text: "fixture-result" },
      status: "ok",
    });
    assert.deepEqual(
      seen.map((entry) => entry.method),
      ["initialize", "notifications/initialized", "tools/call"]
    );
    assert.ok(
      seen.every((entry) => entry.operationId === f.options.operationId)
    );
  } finally {
    server.closeAllConnections();
    const closed = once(server, "close");
    server.close();
    await closed;
  }
});

test("an MCP tool error is never reported as a successful result", async () => {
  const f = await fixture();
  const result = await f.invoke({
    fetch: async (_target, init) => {
      const message = JSON.parse(String(init?.body));
      return (
        mcpHandshake(message) ??
        Response.json({
          id: message.id,
          jsonrpc: "2.0",
          result: { content: [], isError: true },
        })
      );
    },
  });
  assert.deepEqual(result, { status: "UnknownOutcome" });
});

test("discovery makes only read-only MCP tools reads and skips tools the registry cannot load", async () => {
  const listed = [
    {
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object" },
      name: "lookup",
    },
    { inputSchema: { type: "object" }, name: "archive.record" },
    { inputSchema: { type: "object" }, name: "archive_record" },
  ];
  const { skipped, tools } = await discoverMcpTools(
    { id: "crm", url: "https://crm.example.test/mcp" },
    {},
    "production",
    async (_target, init) => {
      const message = JSON.parse(String(init?.body));
      return (
        mcpHandshake(message) ??
        Response.json({
          id: message.id,
          jsonrpc: "2.0",
          result: { tools: listed },
        })
      );
    }
  );
  assert.deepEqual(
    tools.map((tool) => [tool.id, tool.effect, tool.requiresApproval]),
    [
      ["crm_lookup", "read", false],
      ["crm_archive_record", "write", true],
    ]
  );
  assert.deepEqual(skipped, ["archive_record"]);
});
