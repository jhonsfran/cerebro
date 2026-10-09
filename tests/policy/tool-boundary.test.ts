// oxlint-disable unicorn/no-await-expression-member -- Boundary assertions compare the completed contract response directly.
// oxlint-disable eslint/require-await -- Fixture policy ports preserve synchronous state behind asynchronous contracts.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

import { Effect } from "effect";
import { z } from "zod";

import { id } from "../../packages/contracts/src/identity.ts";
import type {
  AuthorizationPolicy,
  EntitlementPolicy,
} from "../../packages/contracts/src/policy.ts";
import type {
  EffectOptions,
  PortResult,
} from "../../packages/contracts/src/port.ts";
import { createAuthorityFake } from "../../packages/contracts/src/testing/effect-fakes.ts";
import {
  allowedContext,
  fixtureAgentId,
  fixtureOrganizationId,
  fixtureRunId,
  userEvent,
} from "../../packages/contracts/src/testing/fixtures.ts";
import type {
  BoundApproval,
  BoundCapability,
  BoundToolCall,
} from "../../packages/contracts/src/tool-service.ts";
import { digestToolArguments } from "../../packages/contracts/src/tools.ts";
import type {
  Approval,
  ToolCall,
  ToolCapability,
  ToolExecution,
} from "../../packages/contracts/src/tools.ts";
import { createAgentAuthority } from "../../packages/policy/src/agent-authority.ts";
import { readBoundedJson } from "../../packages/tools/src/bounded-json.ts";
import { createControlledToolExecutor } from "../../packages/tools/src/broker.ts";
import {
  createCapabilitySigner,
  gatewayInvocation,
} from "../../packages/tools/src/capability.ts";
import {
  createDynamicToolExecutor,
  createDynamicToolExecutorService,
} from "../../packages/tools/src/dynamic-worker.ts";
import type { WorkerLoader } from "../../packages/tools/src/dynamic-worker.ts";
import { createMcpGateway } from "../../packages/tools/src/mcp-gateway.ts";
import {
  encodeMcpHeader,
  readMcpToolResult,
} from "../../packages/tools/src/mcp-transport.ts";
import {
  createToolRegistry,
  bindRegisteredTool,
} from "../../packages/tools/src/registry.ts";
import type { ToolRegistration } from "../../packages/tools/src/registry.ts";

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
    connectorDenied: false,
    denied: false,
    effects: 0,
    entitled: true,
    oversized: false,
    policy: "policy-v1",
    posts: 0,
    reads: 0,
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
  const prepared = registry.prepare(call);
  const options: EffectOptions = {
    deadlineAt: Date.now() + 30_000,
    operationId: id.operation(crypto.randomUUID()),
    requestDigest: await digestToolArguments(prepared.arguments),
  };
  const authorizationPolicy: AuthorizationPolicy = {
    async evaluate(_context, _action, resource) {
      return {
        status: "ok",
        value:
          state.denied ||
          (state.connectorDenied && resource.id === "fixture_connector")
            ? {
                decision: "deny",
                policyVersion: state.policy,
                reason: "Fixture denied.",
              }
            : { decision: "allow", policyVersion: state.policy },
      };
    },
  };
  const entitlementPolicy: EntitlementPolicy = {
    async check() {
      return {
        status: "ok",
        value: state.entitled
          ? { decision: "allow", policyVersion: "entitlement-v1" }
          : {
              decision: "deny",
              policyVersion: "entitlement-v1",
              reason: "Fixture disabled.",
            },
      };
    },
  };
  const signer = await createCapabilitySigner(
    "local-signing-key-fixture-32-bytes-minimum"
  );
  const providerFetch: typeof fetch = async (_request, init) => {
    if (init?.method === "GET") {
      state.reads += 1;
      return Response.json({ text: "receipt-confirmed" });
    }
    state.posts += 1;
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    state.requests.push(body);
    state.effects += 1;
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
  const gatewayDependencies = {
    audience: "fixture-gateway",
    authorizationPolicy,
    credentials: async () => ({
      headers: { Authorization: `Bearer ${secret}` },
      secrets: [secret],
    }),
    entitlementPolicy,
    fetch: providerFetch,
    registry,
    signer,
  };
  const gateway = createMcpGateway(gatewayDependencies);
  const loader: WorkerLoader = {
    get(_id, code) {
      const descriptor = code();
      assert.equal(descriptor.globalOutbound, null);
      assert.deepEqual(Object.keys(descriptor.env), ["GATEWAY"]);
      return {
        getEntrypoint: () => ({
          fetch: async (request) => {
            const incoming = new Request(request);
            return await descriptor.env.GATEWAY.fetch(
              new Request("https://tool-gateway.invalid/invoke", {
                body: await incoming.text(),
                method: "POST",
                signal: incoming.signal,
              })
            );
          },
        }),
      };
    },
  };
  const executor = createDynamicToolExecutor({
    audience: "fixture-gateway",
    authorizationPolicy,
    gateway: {
      fetch: async (request) => await gateway.fetch(new Request(request)),
    },
    loader,
    registry,
    signer,
  });
  const approval: Approval = {
    actorPrincipalId: call.context.actor.id,
    agentId: call.agentId,
    approverId: call.context.actor.id,
    argumentDigest: options.requestDigest,
    connectorId: call.tool.connectorId,
    effect: call.tool.effect,
    expiresAt: Date.now() + 30_000,
    id: "approval-1",
    operationId: options.operationId,
    organizationId: call.organizationId,
    policyVersion: state.policy,
    principalId: call.context.actor.id,
    toolId: call.tool.id,
    toolVersion: call.tool.version,
  };
  const capability: ToolCapability = {
    actorPrincipalId: call.context.actor.id,
    agentId: call.agentId,
    argumentDigest: options.requestDigest,
    connectorId: call.tool.connectorId,
    effect: call.tool.effect,
    expiresAt: options.deadlineAt,
    operationId: options.operationId,
    organizationId: call.organizationId,
    principalId: call.context.actor.id,
    toolId: call.tool.id,
    toolVersion: call.tool.version,
  };
  // Normalize, then dispatch through the real isolated executor and gateway.
  const invoke = async (
    input: ToolCall,
    effect: EffectOptions
  ): Promise<PortResult<ToolExecution>> => {
    let normalized: ToolCall;
    try {
      normalized = registry.prepare(input);
    } catch {
      return { reason: "Tool metadata is invalid.", status: "invalid-input" };
    }
    return await executor.execute(
      normalized,
      {
        ...capability,
        argumentDigest: effect.requestDigest,
        operationId: effect.operationId,
      },
      effect
    );
  };
  const envelope = async (overrides: Partial<ToolCapability> = {}) =>
    await signer.sign(
      gatewayInvocation(
        "fixture-gateway",
        prepared,
        { ...capability, ...overrides },
        options,
        state.policy,
        await digestToolArguments(registry.get(call.tool.id)?.fingerprint)
      )
    );
  return {
    approval,
    call,
    capability,
    close() {
      // The gateway and executor keep no durable state.
    },
    envelope,
    gateway,
    gatewayDependencies,
    invoke,
    loader,
    options,
    prepared,
    registered,
    registry,
    signer,
    state,
  };
};
const gatewayRequest = (envelope: unknown) =>
  new Request("https://tool-gateway.invalid/invoke", {
    body: JSON.stringify(envelope),
    method: "POST",
  });

const controlledFixture = async (
  write = false,
  approvalChange: Partial<BoundApproval> = {}
) => {
  const f = await fixture(write);
  const tool = await Effect.runPromise(
    bindRegisteredTool(f.registry.list()[0])
  );
  const call: BoundToolCall = { ...f.prepared, runId: fixtureRunId, tool };
  const capability: BoundCapability = {
    ...f.capability,
    connectorFingerprint: tool.connectorFingerprint,
    policyVersion: f.state.policy,
    runId: fixtureRunId,
  };
  const approval: BoundApproval = {
    ...f.approval,
    connectorFingerprint: tool.connectorFingerprint,
    runId: fixtureRunId,
    ...approvalChange,
  };
  const pinnedAgent = {
    agentId: call.agentId,
    enabledToolIds: [tool.id],
    grants: [
      {
        action: "execute" as const,
        resource: {
          id: tool.id,
          kind: "tool" as const,
          organizationId: call.organizationId,
        },
      },
      {
        action: "read" as const,
        resource: {
          id: tool.id,
          kind: "tool" as const,
          organizationId: call.organizationId,
        },
      },
      {
        action: "execute" as const,
        resource: {
          id: tool.connectorId,
          kind: "tool" as const,
          organizationId: call.organizationId,
        },
      },
    ],
    instructions: "Fixture",
    model: "fixture/model",
    organizationId: call.organizationId,
    version: 1,
  };
  const current = createAuthorityFake(Date.now);
  current.setDecision({ decision: "allow", policyVersion: f.state.policy });
  const authority = createAgentAuthority({
    checkSession: () => Effect.void,
    current: current.service,
    enabledModels: [pinnedAgent.model],
    entitlements: f.gatewayDependencies.entitlementPolicy,
    tools: [tool],
  });
  const driver = createDynamicToolExecutorService({
    audience: f.gatewayDependencies.audience,
    authorizationPolicy: f.gatewayDependencies.authorizationPolicy,
    gateway: {
      fetch: async (request) => await f.gateway.fetch(new Request(request)),
    },
    loader: f.loader,
    registry: f.registry,
    signer: f.signer,
  });
  const executor = createControlledToolExecutor({
    address: userEvent,
    approval: () => Effect.succeed(approval),
    authority,
    checkApprover: () => Effect.void,
    driver,
    pinnedAgent,
    registry: f.registry,
  });
  return {
    ...f,
    boundApproval: approval,
    boundCall: call,
    boundCapability: capability,
    current,
    executor,
  };
};

test("Effect controlled executor uses the signed restricted MCP gateway for one redacted read", async () => {
  const f = await controlledFixture();
  try {
    const result = await Effect.runPromise(
      f.executor.execute(f.boundCall, f.boundCapability, f.options)
    );
    assert.deepEqual(result, { output: { text: "support [redacted]" } });
    assert.equal(f.state.posts, 1);
    f.current.setDecision({
      decision: "deny",
      policyVersion: "revoked",
      reason: "Revoked",
    });
    const denied = await Effect.runPromise(
      Effect.result(
        f.executor.execute(f.boundCall, f.boundCapability, f.options)
      )
    );
    assert.equal(denied._tag, "Failure");
    assert.equal(f.state.posts, 1);
  } finally {
    f.close();
  }
});

test("Effect controlled writes require an approval bound to the run and connector", async () => {
  const f = await controlledFixture(true);
  try {
    const result = await Effect.runPromise(
      f.executor.execute(f.boundCall, f.boundCapability, f.options)
    );
    assert.deepEqual(result, { output: { text: "support [redacted]" } });
    assert.equal(f.state.posts, 1);
    assert.equal(f.state.effects, 1);
  } finally {
    f.close();
  }
  const g = await controlledFixture(true, { runId: id.run("wrong-run") });
  try {
    const denied = await Effect.runPromise(
      Effect.result(
        g.executor.execute(g.boundCall, g.boundCapability, g.options)
      )
    );
    assert.equal(denied._tag, "Failure");
    if (denied._tag === "Failure") {
      assert.equal(denied.failure._tag, "Denied");
    }
    assert.equal(g.state.posts, 0);
  } finally {
    g.close();
  }
});

test("credential lookup cannot hide a connector revocation before physical dispatch", async () => {
  const f = await fixture();
  try {
    const gateway = createMcpGateway({
      ...f.gatewayDependencies,
      credentials: async () => {
        f.state.connectorDenied = true;
        return { headers: {}, secrets: [] };
      },
    });
    const result = await (
      await gateway.fetch(gatewayRequest(await f.envelope()))
    ).json();
    assert.equal(result.status, "denied");
    assert.equal(f.state.posts, 0);
  } finally {
    f.close();
  }
});

test("Effect gateway uncertainty reports an unknown outcome after one dispatch", async () => {
  const f = await controlledFixture(true);
  try {
    f.state.timeout = true;
    const uncertain = await Effect.runPromise(
      Effect.result(
        f.executor.execute(f.boundCall, f.boundCapability, f.options)
      )
    );
    assert.equal(uncertain._tag, "Failure");
    if (uncertain._tag === "Failure") {
      assert.equal(uncertain.failure._tag, "UnknownOutcome");
    }
    assert.equal(f.state.posts, 1);
    assert.equal(f.state.reads, 0);
  } finally {
    f.close();
  }
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

test("tool calls normalize before digest and use fixed MCP tools/call with redacted output", async () => {
  const f = await fixture();
  try {
    const result = await f.invoke(f.call, f.options);
    assert.deepEqual(result, {
      status: "ok",
      value: { output: { text: "support [redacted]" } },
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
    assert.equal(f.state.posts, 1);
  } finally {
    f.close();
  }
});

test("wrong normalized digest and caller-overridden connector metadata cannot dispatch", async () => {
  const f = await fixture();
  try {
    const rawDigest = await digestToolArguments(f.call.arguments);
    assert.equal(
      (
        await f.invoke(f.call, {
          ...f.options,
          requestDigest: rawDigest,
        })
      ).status,
      "denied"
    );
    assert.equal(
      (
        await f.invoke(
          { ...f.call, tool: { ...f.call.tool, connectorId: "foreign" } },
          f.options
        )
      ).status,
      "invalid-input"
    );
    assert.equal(f.state.posts, 0);
    assert.equal((await f.invoke(f.call, f.options)).status, "ok");
  } finally {
    f.close();
  }
});

test("gateway rejects forged, widened and wrong-audience capabilities", async () => {
  const f = await fixture(true);
  try {
    const signed = await f.envelope();
    const tampered = {
      ...signed,
      payload: signed.payload.replace("support", "changed"),
    };
    assert.equal((await f.gateway.fetch(gatewayRequest(tampered))).status, 403);
    const widened = await f.envelope({ connectorId: "foreign" });
    assert.equal((await f.gateway.fetch(gatewayRequest(widened))).status, 403);
    const foreign = await f.signer.sign({
      ...JSON.parse(signed.payload),
      audience: "foreign",
    });
    assert.equal((await f.gateway.fetch(gatewayRequest(foreign))).status, 403);
    const first = await (await f.gateway.fetch(gatewayRequest(signed))).json();
    assert.deepEqual(first, {
      status: "ok",
      value: { output: { text: "support [redacted]" } },
    });
    assert.equal(f.state.posts, 1);
  } finally {
    f.close();
  }
});

for (const [name, change] of Object.entries({
  actor: { actorPrincipalId: id.principal("foreign") },
  arguments: { argumentDigest: id.digest(`sha256:${"0".repeat(64)}`) },
  connector: { connectorId: "foreign" },
  expiry: { expiresAt: Date.now() - 1 },
  policy: { policyVersion: "policy-old" },
  principal: { principalId: id.principal("foreign") },
  version: { toolVersion: "2" },
})) {
  test(`stale approval ${name} is denied before dispatch`, async () => {
    const f = await controlledFixture(true, change);
    try {
      const denied = await Effect.runPromise(
        Effect.result(
          f.executor.execute(f.boundCall, f.boundCapability, f.options)
        )
      );
      assert.equal(denied._tag, "Failure");
      if (denied._tag === "Failure") {
        assert.equal(denied.failure._tag, "Denied");
      }
      assert.equal(f.state.posts, 0);
    } finally {
      f.close();
    }
  });
}

test("revoked authorization and entitlement deny later calls and gateway replay", async () => {
  const f = await fixture();
  try {
    const signed = await f.envelope();
    assert.equal((await f.invoke(f.call, f.options)).status, "ok");
    f.state.denied = true;
    assert.equal((await f.invoke(f.call, f.options)).status, "denied");
    assert.equal(
      (await (await f.gateway.fetch(gatewayRequest(signed))).json()).status,
      "denied"
    );
    f.state.denied = false;
    f.state.entitled = false;
    assert.equal(
      (await (await f.gateway.fetch(gatewayRequest(signed))).json()).status,
      "denied"
    );
    assert.equal(f.state.posts, 1);
  } finally {
    f.close();
  }
});

test("gateway checks current connector access separately", async () => {
  const f = await fixture();
  try {
    f.state.connectorDenied = true;
    assert.deepEqual(await f.invoke(f.call, f.options), {
      code: "unauthorized",
      reason: "Current policy denies connector access.",
      status: "denied",
    });
    assert.equal(f.state.posts, 0);
    f.state.connectorDenied = false;
    assert.equal(
      (
        await f.invoke(f.call, {
          ...f.options,
          operationId: id.operation(crypto.randomUUID()),
        })
      ).status,
      "ok"
    );
  } finally {
    f.close();
  }
});

test("provider stream limit cancels before parse and cannot produce a successful tool result", async () => {
  const f = await fixture();
  try {
    f.state.oversized = true;
    assert.equal((await f.invoke(f.call, f.options)).status, "unknown-outcome");
    assert.equal(f.state.cancelledStream, true);
    assert.equal(f.state.posts, 1);
  } finally {
    f.close();
  }
});

test("registry and results reject caller mutation", async () => {
  const f = await fixture();
  try {
    Reflect.set(f.registered.target, "url", "https://foreign.invalid/");
    const first = await f.invoke(f.call, f.options);
    assert.deepEqual(first, {
      status: "ok",
      value: { output: { text: "support [redacted]" } },
    });
    if (first.status === "ok") {
      Reflect.set(first.value.output, "text", "changed");
    }
    assert.deepEqual(await f.invoke(f.call, f.options), {
      status: "ok",
      value: { output: { text: "support [redacted]" } },
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
  } finally {
    f.close();
  }
});

test("signed registration fingerprint rejects a changed fixed destination", async () => {
  const f = await fixture();
  try {
    const signed = await f.envelope();
    const original = registration();
    const registry = createToolRegistry(
      [
        {
          ...original,
          target: { ...original.target, url: "https://foreign.invalid/mcp" },
        },
      ],
      "local"
    );
    const changedGateway = createMcpGateway({
      ...f.gatewayDependencies,
      registry,
    });
    assert.deepEqual(
      await (await changedGateway.fetch(gatewayRequest(signed))).json(),
      {
        code: "version-mismatch",
        reason:
          "The signed tool registration differs from the gateway registry.",
        status: "conflict",
      }
    );
    assert.equal(f.state.posts, 0);
    assert.equal((await f.invoke(f.call, f.options)).status, "ok");
  } finally {
    f.close();
  }
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

test("dynamic executor cancels a stalled wrapper response body after cancellation", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let cancelled = false;
  const loader: WorkerLoader = {
    get() {
      return {
        getEntrypoint: () => ({
          fetch: async () =>
            new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              })
            ),
        }),
      };
    },
  };
  const executor = createDynamicToolExecutor({
    audience: "fixture-gateway",
    authorizationPolicy: f.gatewayDependencies.authorizationPolicy,
    gateway: {
      fetch: async (request) => await f.gateway.fetch(new Request(request)),
    },
    loader,
    registry: f.registry,
    signer: f.signer,
  });
  const capability: ToolCapability = {
    actorPrincipalId: f.call.context.actor.id,
    agentId: f.call.agentId,
    argumentDigest: f.options.requestDigest,
    connectorId: f.call.tool.connectorId,
    effect: f.call.tool.effect,
    expiresAt: f.options.deadlineAt,
    operationId: f.options.operationId,
    organizationId: f.call.organizationId,
    principalId: f.call.context.actor.id,
    toolId: f.call.tool.id,
    toolVersion: f.call.tool.version,
  };
  const timer = setTimeout(() => controller.abort(), 25);
  try {
    const result = await executor.execute(f.prepared, capability, {
      ...f.options,
      signal: controller.signal,
    });
    assert.equal(result.status, "unknown-outcome");
    assert.equal(cancelled, true);
    assert.equal(f.state.posts, 0);
  } finally {
    clearTimeout(timer);
    f.close();
  }
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
    const gateway = createMcpGateway({
      ...f.gatewayDependencies,
      fetch: async (target, init) => {
        assert.equal(target, "https://fixture.invalid/mcp");
        return await fetch(`http://127.0.0.1:${address.port}/mcp`, init);
      },
    });
    const envelope = await f.envelope();
    const result = await gateway.fetch(gatewayRequest(envelope));
    assert.deepEqual(await result.json(), {
      status: "ok",
      value: { output: { text: "fixture-result" } },
    });
    assert.ok(observed);
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    const closed = once(server, "close");
    server.close();
    await closed;
    f.close();
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
  try {
    const gateway = createMcpGateway({
      ...f.gatewayDependencies,
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
    const envelope = await f.envelope();
    assert.equal(
      (await (await gateway.fetch(gatewayRequest(envelope))).json()).status,
      "unknown-outcome"
    );
    assert.equal(requests, 1);
  } finally {
    f.close();
  }
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
