// oxlint-disable unicorn/no-await-expression-member -- Boundary assertions compare completed contract decisions.
// oxlint-disable eslint/no-await-in-loop -- Each denial case uses an isolated fixture and asserts its counter.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";
import { z } from "zod";

import { createAgentAuthority } from "../../packages/authorization/src/agent-authority.ts";
import type { AuthorityRequest } from "../../packages/contracts/src/authority-service.ts";
import { Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type { AgentDefinition } from "../../packages/contracts/src/session.ts";
import {
  bindRegisteredTool,
  createToolRegistry,
} from "../../packages/tools/src/registry.ts";
import { createAuthorityFake } from "../support/effect-fakes.ts";
import { allowedContext, userEvent } from "../support/fixtures.ts";

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
  return {
    agent,
    authority,
    current,
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

test("invalid deadlines fail in the typed channel before authority", async () => {
  const f = await fixture();
  for (const deadlineAt of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      await failureTag(f.authority.require(f.request, { deadlineAt })),
      "Unavailable"
    );
  }
});
