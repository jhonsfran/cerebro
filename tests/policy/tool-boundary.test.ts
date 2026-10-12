// oxlint-disable unicorn/no-await-expression-member -- Boundary assertions compare the completed contract response directly.
// oxlint-disable eslint/require-await -- Fixture providers answer synchronously behind the async fetch contract.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

import { Effect } from "effect";
import { z } from "zod";

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
import {
  encodeMcpHeader,
  readMcpToolResult,
} from "../../packages/tools/src/mcp-transport.ts";
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
        kind: "mcp-read",
        method: "fixture-search",
        url: "https://fixture.invalid/mcp",
      },
});
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
    state.posts += 1;
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    state.requests.push(body);
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
            id: body?.id ?? options.operationId,
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
      id: f.options.operationId,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "cerebro",
            version: "0.0.0",
          },
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          progressToken: f.options.operationId,
        },
        arguments: { query: "support" },
        name: "fixture-search",
      },
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
  const f = await fixture();
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

const mcpReply = (operationId: string, text = "fixture-result") => ({
  id: operationId,
  jsonrpc: "2.0",
  result: {
    content: [{ text, type: "text" }],
    structuredContent: { text },
  },
});
const sseResponse = (source: string, chunkSize = 7) => {
  const bytes = new TextEncoder().encode(source);
  let offset = 0;
  const state = { cancelled: false };
  return {
    response: new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          state.cancelled = true;
        },
        pull(controller) {
          if (offset < bytes.byteLength) {
            controller.enqueue(bytes.slice(offset, offset + chunkSize));
            offset += chunkSize;
          }
        },
      }),
      { headers: { "content-type": "text/event-stream; charset=utf-8" } }
    ),
    state,
  };
};

test("local HTTP MCP provider enforces pinned headers and metadata and returns SSE", async () => {
  const f = await fixture();
  let observed: unknown;
  let requests = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf-8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests += 1;
      const parsed = JSON.parse(body);
      observed = { body: parsed, headers: request.headers };
      const valid =
        request.headers["mcp-protocol-version"] === "2026-07-28" &&
        request.headers["mcp-method"] === "tools/call" &&
        request.headers["mcp-name"] === parsed.params.name &&
        request.headers.accept === "application/json, text/event-stream" &&
        parsed.params._meta["io.modelcontextprotocol/protocolVersion"] ===
          "2026-07-28" &&
        parsed.params._meta["io.modelcontextprotocol/clientInfo"].name ===
          "cerebro" &&
        parsed.params._meta["io.modelcontextprotocol/clientInfo"].version ===
          "0.0.0" &&
        Object.keys(
          parsed.params._meta["io.modelcontextprotocol/clientCapabilities"]
        ).length === 0;
      if (!valid) {
        response.writeHead(400);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1, progressToken: parsed.id } })}\n\n`
      );
      response.end(`data: ${JSON.stringify(mcpReply(parsed.id))}\n\n`);
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
        assert.equal(target, "https://fixture.invalid/mcp");
        return await fetch(`http://127.0.0.1:${address.port}/mcp`, init);
      },
    });
    assert.deepEqual(result, {
      output: { text: "fixture-result" },
      status: "ok",
    });
    assert.ok(observed);
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    const closed = once(server, "close");
    server.close();
    await closed;
  }
});

test("MCP names use exact UTF-8 Base64 sentinel encoding", () => {
  assert.equal(encodeMcpHeader("fixture-search"), "fixture-search");
  for (const name of [
    "世界",
    " padded ",
    "line1\nline2",
    "=?base64?literal?=",
  ]) {
    assert.equal(
      encodeMcpHeader(name),
      `=?base64?${Buffer.from(name, "utf-8").toString("base64")}?=`
    );
  }
});

test("SSE reads split UTF-8 and CRLF, ignores request notifications, and cancels at final", async () => {
  const operationId = "sse-op";
  const source = [
    ": heartbeat",
    "",
    `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1, progressToken: operationId } })}`,
    "",
    `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { data: "fixture", level: "info" } })}`,
    "",
    "event: message",
    `data: ${JSON.stringify(mcpReply(operationId, "世界"))}`,
    "",
    "",
  ].join("\r\n");
  const stream = sseResponse(source, 1);
  assert.deepEqual(
    await readMcpToolResult(
      stream.response,
      1024,
      operationId,
      AbortSignal.timeout(1000)
    ),
    { text: "世界" }
  );
  assert.equal(stream.state.cancelled, true);
});

for (const [label, data] of [
  ["malformed JSON", "{"],
  ["wrong response ID", JSON.stringify(mcpReply("other"))],
  [
    "independent server request",
    JSON.stringify({
      id: "server",
      jsonrpc: "2.0",
      method: "sampling/createMessage",
      params: {},
    }),
  ],
  [
    "unrelated notification",
    JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: {},
    }),
  ],
  [
    "unrelated progress",
    JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progress: 1, progressToken: "other" },
    }),
  ],
  [
    "RPC revision error",
    JSON.stringify({
      error: { code: -32_000, message: "Unsupported version" },
      id: "op",
      jsonrpc: "2.0",
    }),
  ],
  [
    "non-MCP business result",
    JSON.stringify({ id: "op", jsonrpc: "2.0", result: { text: "value" } }),
  ],
  [
    "MCP tool error",
    JSON.stringify({
      id: "op",
      jsonrpc: "2.0",
      result: { content: [], isError: true },
    }),
  ],
] as const) {
  test(`SSE rejects ${label} and cancels the stream`, async () => {
    const stream = sseResponse(`data: ${data}\n\n`);
    await assert.rejects(
      readMcpToolResult(stream.response, 1024, "op", AbortSignal.timeout(1000))
    );
    assert.equal(stream.state.cancelled, true);
  });
}

test("SSE byte bounds and cancellation apply before parsing the final result", async () => {
  const oversized = sseResponse(`: ${"x".repeat(1025)}\n\n`, 1025);
  await assert.rejects(
    readMcpToolResult(
      oversized.response,
      1024,
      "op",
      AbortSignal.timeout(1000)
    ),
    /byte limit/u
  );
  assert.equal(oversized.state.cancelled, true);
  const pending = sseResponse(": waiting\n\n");
  const abort = new AbortController();
  const reading = readMcpToolResult(pending.response, 1024, "op", abort.signal);
  abort.abort();
  await assert.rejects(reading);
  assert.equal(pending.state.cancelled, true);
});

test("MCP JSON validates IDs and required content, and returns full result without structuredContent", async () => {
  const signal = AbortSignal.timeout(1000);
  await assert.rejects(
    readMcpToolResult(Response.json(mcpReply("wrong")), 1024, "op", signal)
  );
  await assert.rejects(
    readMcpToolResult(
      Response.json({
        id: "op",
        jsonrpc: "2.0",
        result: { structuredContent: { text: "x" } },
      }),
      1024,
      "op",
      signal
    )
  );
  const content = { content: [{ text: "fixture", type: "text" }] };
  assert.deepEqual(
    await readMcpToolResult(
      Response.json({ id: "op", jsonrpc: "2.0", result: content }),
      1024,
      "op",
      signal
    ),
    content
  );
});

test("unsupported protocol responses never trigger a downgrade retry", async () => {
  const f = await fixture();
  let requests = 0;
  const result = await f.invoke({
    fetch: async (_request, init) => {
      requests += 1;
      assert.equal(
        new Headers(init?.headers).get("MCP-Protocol-Version"),
        "2026-07-28"
      );
      return Response.json(
        {
          error: {
            code: -32_000,
            data: { supportedVersions: ["2025-11-25"] },
            message: "unsupported",
          },
          id: f.options.operationId,
          jsonrpc: "2.0",
        },
        { status: 400 }
      );
    },
  });
  assert.deepEqual(result, { status: "UnknownOutcome" });
  assert.equal(requests, 1);
});

test("MCP registry rejects custom parameter header annotations before invocation", () => {
  const entry = registration();
  assert.throws(
    () =>
      createToolRegistry(
        [
          {
            ...entry,
            input: z.strictObject({
              query: z.string().meta({ "x-mcp-header": "Query" }),
            }),
          },
        ],
        "production"
      ),
    /header annotations are unsupported/u
  );
});
