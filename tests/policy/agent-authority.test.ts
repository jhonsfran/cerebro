// oxlint-disable unicorn/no-await-expression-member -- Boundary assertions compare completed contract decisions.
// oxlint-disable eslint/no-await-in-loop -- Each denial case uses an isolated fixture and asserts its counter.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Fiber } from "effect";
import { z } from "zod";

import { createAgentAuthority } from "../../packages/authorization/src/agent-authority.ts";
import type { AuthorityRequest } from "../../packages/contracts/src/authority-service.ts";
import {
  Denied,
  UnknownOutcome,
} from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type { AgentDefinition } from "../../packages/contracts/src/session.ts";
import type {
  BoundApproval,
  BoundCapability,
  BoundToolCall,
  ToolExecutor,
} from "../../packages/contracts/src/tool-service.ts";
import { digestToolArguments } from "../../packages/contracts/src/tools.ts";
import { createControlledToolExecutor } from "../../packages/tools/src/broker.ts";
import type { ControlledToolDependencies } from "../../packages/tools/src/broker.ts";
import {
  bindRegisteredTool,
  createToolRegistry,
} from "../../packages/tools/src/registry.ts";
import {
  createAuthorityFake,
  createToolFake,
} from "../support/effect-fakes.ts";
import {
  allowedContext,
  userEvent,
  fixtureRunId,
} from "../support/fixtures.ts";

const clock = () => 1_800_000_000_000;
const options = { deadlineAt: clock() + 10_000 };

const fixture = async (write = false) => {
  const registry = createToolRegistry(
    [
      {
        connectorVersion: "connector-v1",
        definition: {
          connectorId: "connector-1",
          effect: write ? "write" : "read",
          id: id.tool("tool-1"),
          version: "tool-v1",
        },
        description: "Fixture tool",
        input: z.strictObject({ query: z.string() }),
        maxInputBytes: 1024,
        maxOutputBytes: 1024,
        output: z.string(),
        requiresApproval: write,
        retryMode: "at-most-once",
        target: write
          ? {
              kind: "http-write",
              method: "effect",
              url: "http://fixture.invalid/effect",
            }
          : {
              kind: "mcp-read",
              method: "search",
              url: "https://fixture.invalid/mcp",
            },
      },
    ],
    "local"
  );
  const tool = await Effect.runPromise(bindRegisteredTool(registry.list()[0]));
  const agent: AgentDefinition = {
    agentId: userEvent.agentId,
    enabledToolIds: [tool.id],
    grants: [
      {
        action: "execute",
        resource: {
          id: tool.id,
          kind: "tool",
          organizationId: userEvent.organizationId,
        },
      },
      {
        action: "read",
        resource: {
          id: tool.id,
          kind: "tool",
          organizationId: userEvent.organizationId,
        },
      },
      {
        action: "execute",
        resource: {
          id: tool.connectorId,
          kind: "tool",
          organizationId: userEvent.organizationId,
        },
      },
    ],
    instructions: "Fixture",
    model: "fixture/model",
    organizationId: userEvent.organizationId,
    version: 1,
  };
  const request: AuthorityRequest = {
    action: "execute",
    address: userEvent,
    context: allowedContext,
    pinnedAgent: agent,
    resource: {
      id: tool.id,
      kind: "tool",
      organizationId: userEvent.organizationId,
    },
    tool,
  };
  const current = createAuthorityFake(clock);
  const state = { approver: true, enabled: true, session: true };
  const authority = createAgentAuthority({
    checkSession: () =>
      state.session
        ? Effect.void
        : Effect.fail(
            new Denied({ code: "unauthorized", reason: "Foreign session" })
          ),
    current: current.service,
    enabledModels: [agent.model],
    entitlements: {
      check: () =>
        Promise.resolve({
          status: "ok",
          value: state.enabled
            ? { decision: "allow", policyVersion: "current-agent:1" }
            : {
                decision: "deny",
                policyVersion: "current-agent:2",
                reason: "Disabled current capability",
              },
        }),
    },
    now: clock,
    tools: [tool],
  });
  const call: BoundToolCall = {
    agentId: agent.agentId,
    arguments: { query: "support" },
    context: allowedContext,
    organizationId: agent.organizationId,
    runId: fixtureRunId,
    tool,
  };
  const effect = {
    ...options,
    operationId: id.operation("operation-1"),
    requestDigest: await digestToolArguments(call.arguments),
  };
  const capability: BoundCapability = {
    actorPrincipalId: call.context.actor.id,
    agentId: call.agentId,
    argumentDigest: effect.requestDigest,
    connectorFingerprint: tool.connectorFingerprint,
    connectorId: tool.connectorId,
    effect: tool.effect,
    expiresAt: options.deadlineAt,
    operationId: effect.operationId,
    organizationId: call.organizationId,
    policyVersion: "fixture-v1",
    principalId: call.context.actor.id,
    runId: call.runId,
    toolId: tool.id,
    toolVersion: tool.version,
  };
  const approval: BoundApproval = {
    ...capability,
    approverId: call.context.actor.id,
    id: "approval-1",
  };
  const driver = createToolFake(clock);
  const dependencies: ControlledToolDependencies = {
    address: request.address,
    approval: () => Effect.succeed(approval),
    authority,
    checkApprover: () =>
      state.approver
        ? Effect.void
        : Effect.fail(
            new Denied({ code: "revoked", reason: "Approver revoked" })
          ),
    driver: driver.service,
    now: clock,
    pinnedAgent: agent,
    registry,
  };
  const executor = createControlledToolExecutor(dependencies);
  return {
    agent,
    approval,
    authority,
    call,
    capability,
    current,
    dependencies,
    driver,
    effect,
    executor,
    registry,
    request,
    state,
    tool,
  };
};

const failureTag = async <A>(
  program: Effect.Effect<A, { readonly _tag: string }>
) => {
  const result = await Effect.runPromise(Effect.result(program));
  assert.equal(result._tag, "Failure");
  return result._tag === "Failure" ? result.failure._tag : undefined;
};

test("agent authority intersects pinned grants, current capabilities, company and stored session ownership", async () => {
  const f = await fixture();
  assert.equal(
    (await Effect.runPromise(f.authority.evaluate(f.request, options)))
      .decision,
    "allow"
  );
  const denied: AuthorityRequest[] = [
    { ...f.request, pinnedAgent: { ...f.agent, grants: [] } },
    { ...f.request, pinnedAgent: { ...f.agent, enabledToolIds: [] } },
    {
      ...f.request,
      pinnedAgent: {
        ...f.agent,
        grants: f.agent.grants.filter(
          (grant) => grant.resource.id !== f.tool.connectorId
        ),
      },
    },
    {
      ...f.request,
      address: {
        ...f.request.address,
        organizationId: id.organization("foreign"),
      },
    },
    {
      ...f.request,
      address: { ...f.request.address, agentId: id.agent("foreign") },
    },
    {
      ...f.request,
      tool: {
        ...f.tool,
        connectorFingerprint: id.digest(`sha256:${"0".repeat(64)}`),
      },
    },
    {
      ...f.request,
      context: { actor: { ...allowedContext.actor, state: "disabled" } },
    },
  ];
  for (const request of denied) {
    assert.equal(
      (await Effect.runPromise(f.authority.evaluate(request, options)))
        .decision,
      "deny"
    );
    assert.equal(
      await failureTag(f.authority.require(request, options)),
      "Denied"
    );
  }
  f.state.enabled = false;
  assert.equal(
    await failureTag(f.authority.require(f.request, options)),
    "Denied"
  );
  f.state.enabled = true;
  f.state.session = false;
  assert.equal(
    await failureTag(f.authority.require(f.request, options)),
    "Denied"
  );
  f.state.session = true;
  f.current.setAvailable(false);
  assert.equal(
    await failureTag(f.authority.require(f.request, options)),
    "Unavailable"
  );
});

test("model dispatch authority checks the pinned and configured model on every evaluation", async () => {
  const f = await fixture();
  const request: AuthorityRequest = {
    ...f.request,
    model: f.agent.model,
    resource: {
      id: f.agent.agentId,
      kind: "agent",
      organizationId: f.agent.organizationId,
    },
    tool: undefined,
  };
  assert.equal(
    (await Effect.runPromise(f.authority.evaluate(request, options))).decision,
    "allow"
  );
  assert.equal(
    await failureTag(
      f.authority.require({ ...request, model: "foreign/model" }, options)
    ),
    "Denied"
  );
  f.current.setDecision({
    decision: "deny",
    policyVersion: "revoked",
    reason: "Revoked",
  });
  assert.equal(
    await failureTag(f.authority.require(request, options)),
    "Denied"
  );
});

test("controlled reads dispatch through the driver and deny after revocation", async () => {
  const f = await fixture();
  assert.deepEqual(
    await Effect.runPromise(f.executor.execute(f.call, f.capability, f.effect)),
    { output: "fixture result", providerReceipt: "fixture receipt" }
  );
  assert.equal(f.driver.counts.dispatch, 1);
  f.current.setDecision({
    decision: "deny",
    policyVersion: "revoked",
    reason: "Revoked",
  });
  assert.equal(
    await failureTag(f.executor.execute(f.call, f.capability, f.effect)),
    "Denied"
  );
  assert.equal(f.driver.counts.dispatch, 1);
});

test("run, connector, arguments, actor, represented principal, delegation, version, policy and expiry bindings deny writes", async () => {
  const changes: Partial<BoundApproval>[] = [
    { runId: id.run("foreign") },
    { connectorFingerprint: id.digest(`sha256:${"0".repeat(64)}`) },
    { argumentDigest: id.digest(`sha256:${"0".repeat(64)}`) },
    { actorPrincipalId: id.principal("foreign") },
    { principalId: id.principal("foreign") },
    { delegationId: id.delegation("foreign") },
    { toolVersion: "foreign" },
    { policyVersion: "foreign" },
    { expiresAt: clock() },
    { organizationId: id.organization("foreign") },
    { operationId: id.operation("foreign") },
  ];
  for (const change of changes) {
    const f = await fixture(true);
    const executor = createControlledToolExecutor({
      ...f.dependencies,
      approval: () => Effect.succeed({ ...f.approval, ...change }),
    });
    assert.equal(
      await failureTag(executor.execute(f.call, f.capability, f.effect)),
      "Denied"
    );
    assert.equal(f.driver.counts.dispatch, 0);
  }
});

test("authority and approver are rechecked after approval wait and immediately before dispatch", async () => {
  const f = await fixture(true);
  const executor = createControlledToolExecutor({
    ...f.dependencies,
    approval: () =>
      Effect.sync(() => {
        f.current.setDecision({
          decision: "deny",
          policyVersion: "revoked",
          reason: "Revoked during approval wait",
        });
        return f.approval;
      }),
  });
  assert.equal(
    await failureTag(executor.execute(f.call, f.capability, f.effect)),
    "Denied"
  );
  assert.equal(f.driver.counts.dispatch, 0);
  const g = await fixture(true);
  g.state.approver = false;
  assert.equal(
    await failureTag(g.executor.execute(g.call, g.capability, g.effect)),
    "Denied"
  );
  assert.equal(g.driver.counts.dispatch, 0);
  const h = await fixture(true);
  const final = createControlledToolExecutor({
    ...h.dependencies,
    checkApprover: () =>
      Effect.sync(() =>
        h.current.setDecision({
          decision: "deny",
          policyVersion: "revoked",
          reason: "Revoked before physical dispatch",
        })
      ),
  });
  assert.equal(
    await failureTag(final.execute(h.call, h.capability, h.effect)),
    "Denied"
  );
  assert.equal(h.driver.counts.dispatch, 0);
});

test("an uncertain write reports UnknownOutcome after one dispatch", async () => {
  const f = await fixture(true);
  let effects = 0;
  const driver: ToolExecutor = {
    execute: () =>
      Effect.flatMap(
        Effect.sync(() => {
          effects += 1;
        }),
        () =>
          Effect.fail(
            new UnknownOutcome({
              operationId: f.effect.operationId,
              reason: "Provider reply lost",
            })
          )
      ),
  };
  const executor = createControlledToolExecutor({ ...f.dependencies, driver });
  assert.equal(
    await failureTag(executor.execute(f.call, f.capability, f.effect)),
    "UnknownOutcome"
  );
  assert.equal(effects, 1);
});

test("invalid driver output after dispatch is an unknown outcome", async () => {
  const f = await fixture(true);
  const driver: ToolExecutor = {
    execute: () => Effect.succeed({ output: "x".repeat(1025) }),
  };
  const executor = createControlledToolExecutor({ ...f.dependencies, driver });
  assert.equal(
    await failureTag(executor.execute(f.call, f.capability, f.effect)),
    "UnknownOutcome"
  );
});

test("Effect interruption stops the driver after the caller stops", async () => {
  const f = await fixture(true);
  const entered = Promise.withResolvers<null>();
  let interrupted = false;
  const driver: ToolExecutor = {
    ...f.driver.service,
    execute: () =>
      Effect.sync(() => entered.resolve(null)).pipe(
        Effect.flatMap(() => Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          })
        )
      ),
  };
  const executor = createControlledToolExecutor({ ...f.dependencies, driver });
  const fiber = Effect.runFork(
    executor.execute(f.call, f.capability, f.effect)
  );
  await entered.promise;
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(interrupted, true);
});

test("unavailable, expired or foreign capability never dispatches", async () => {
  const f = await fixture();
  f.current.setAvailable(false);
  assert.equal(
    await failureTag(f.executor.execute(f.call, f.capability, f.effect)),
    "Unavailable"
  );
  f.current.setAvailable(true);
  assert.equal(
    await failureTag(
      f.executor.execute(
        f.call,
        { ...f.capability, expiresAt: clock() },
        f.effect
      )
    ),
    "Denied"
  );
  assert.equal(
    await failureTag(
      f.executor.execute(
        { ...f.call, organizationId: id.organization("foreign") },
        f.capability,
        f.effect
      )
    ),
    "Denied"
  );
  assert.equal(
    await failureTag(
      f.executor.execute(f.call, f.capability, {
        ...f.effect,
        deadlineAt: clock(),
      })
    ),
    "Unavailable"
  );
  assert.equal(f.driver.counts.dispatch, 0);
});

test("caller cancellation and deadlines stop an approval wait with zero dispatches", async () => {
  const f = await fixture(true);
  const entered = Promise.withResolvers<null>();
  const controller = new AbortController();
  const executor = createControlledToolExecutor({
    ...f.dependencies,
    approval: () =>
      Effect.sync(() => entered.resolve()).pipe(
        Effect.flatMap(() => Effect.never)
      ),
  });
  const pending = failureTag(
    executor.execute(f.call, f.capability, {
      ...f.effect,
      signal: controller.signal,
    })
  );
  await entered.promise;
  controller.abort();
  assert.equal(await pending, "Unavailable");
  assert.equal(f.driver.counts.dispatch, 0);
  assert.equal(
    await failureTag(
      executor.execute(f.call, f.capability, {
        ...f.effect,
        deadlineAt: clock() + 20,
      })
    ),
    "Unavailable"
  );
  assert.equal(f.driver.counts.dispatch, 0);
});

test("an expired capability after the approval wait cannot dispatch", async () => {
  const f = await fixture(true);
  let now = clock();
  const executor = createControlledToolExecutor({
    ...f.dependencies,
    approval: () =>
      Effect.sync(() => {
        now += 100;
        return f.approval;
      }),
    now: () => now,
  });
  assert.equal(
    await failureTag(
      executor.execute(
        f.call,
        { ...f.capability, expiresAt: clock() + 50 },
        f.effect
      )
    ),
    "Denied"
  );
  assert.equal(f.driver.counts.dispatch, 0);
});

test("authority stops waiting for unavailable session and capability adapters", async () => {
  const f = await fixture();
  const session = createAgentAuthority({
    checkSession: () => Effect.never,
    current: f.current.service,
    enabledModels: [f.agent.model],
    entitlements: { check: () => Promise.withResolvers<never>().promise },
    now: clock,
    tools: [f.tool],
  });
  assert.equal(
    await failureTag(session.require(f.request, { deadlineAt: clock() + 20 })),
    "Unavailable"
  );
  const entered = Promise.withResolvers<null>();
  const capability = createAgentAuthority({
    checkSession: () => Effect.void,
    current: f.current.service,
    enabledModels: [f.agent.model],
    entitlements: {
      check: () => {
        entered.resolve(null);
        return Promise.withResolvers<never>().promise;
      },
    },
    now: clock,
    tools: [f.tool],
  });
  const controller = new AbortController();
  const pending = failureTag(
    capability.require(f.request, { ...options, signal: controller.signal })
  );
  await entered.promise;
  controller.abort();
  assert.equal(await pending, "Unavailable");
});

test("invalid deadlines fail in the typed channel before authority or tool dispatch", async () => {
  const f = await fixture();
  for (const deadlineAt of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      await failureTag(
        f.executor.execute(f.call, f.capability, { ...f.effect, deadlineAt })
      ),
      "Unavailable"
    );
    assert.equal(
      await failureTag(f.authority.require(f.request, { deadlineAt })),
      "Unavailable"
    );
  }
  assert.equal(f.driver.counts.dispatch, 0);
});
