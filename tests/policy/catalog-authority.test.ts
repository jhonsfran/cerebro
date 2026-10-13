// oxlint-disable unicorn/no-await-expression-member -- Assertions check completed boundary decisions.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { Effect } from "effect";

import {
  createCurrentAuthority,
  createCurrentEntitlements,
} from "../../apps/server/src/access.ts";
import { catalogTools } from "../../apps/server/src/catalog.ts";
import { createCatalogRegistry } from "../../apps/server/src/config.ts";
import { createConnectorAdmin } from "../../apps/server/src/connectors.ts";
import { createAgentAuthority } from "../../packages/authorization/src/agent-authority.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { withDatabase } from "../../packages/db/src/index.ts";
import { findSealedAccount } from "../../packages/db/src/repositories/accounts.ts";
import { publishAgentConfiguration } from "../../packages/db/src/repositories/agents.ts";
import { saveAdminConnector } from "../../packages/db/src/repositories/catalog.ts";
import { createIdentityRepository } from "../../packages/db/src/repositories/identity.ts";
import { user } from "../../packages/db/src/schema/auth.ts";
import { organization } from "../../packages/db/src/schema/core.ts";
import { openCredentials } from "../../packages/tools/src/accounts.ts";
import { createConnectorExecutor } from "../../packages/tools/src/connector.ts";
import { bindRegisteredTool } from "../../packages/tools/src/registry.ts";

const fixture = async () => {
  const databaseUrl = process.env.POLICY_TEST_DATABASE_URL;
  assert.ok(databaseUrl);
  const env = {
    DATABASE_URL: databaseUrl,
    DEPLOY_MODE: "local" as const,
    ACCOUNT_KEY: "fixture-account-key-with-at-least-32-characters",
    RUNTIME_CONFIG_JSON: JSON.stringify({
      mode: "local",
      retrievalMode: "full-text",
      tools: [],
      connectors: [],
      bootstrapToken: "x".repeat(32),
      gatewaySigningKey: "y".repeat(32),
      artifacts: {
        accessKeyId: "fixture",
        secretAccessKey: "fixture-secret",
        endpoint: "http://fixture.invalid",
        region: "us-east-1",
        bucket: "fixture",
      },
      models: [
        {
          id: "fixture/model",
          provider: "fixture",
          model: "model",
          baseUrl: "http://fixture.invalid/v1",
          apiKey: "fixture",
          deadlineMs: 1000,
          maxInputBytes: 65_536,
          maxOutputTokens: 100,
          maxResponseBytes: 65_536,
        },
      ],
    }),
  };
  const organizationId = id.organization(`catalog-${randomUUID()}`);
  const userId = randomUUID();
  const principal = await withDatabase(env, async (database) => {
    await database
      .insert(organization)
      .values({ id: organizationId, name: "Catalog fixture" });
    await database.insert(user).values({
      id: userId,
      email: `${userId}@example.test`,
      name: "Catalog actor",
      emailVerified: true,
    });
    return await createIdentityRepository(database).provisionHumanPrincipal(
      organizationId,
      userId
    );
  });
  const context = {
    actor: {
      id: id.principal(principal.id),
      kind: "human" as const,
      organizationId,
      state: "active" as const,
    },
  };
  return { context, env, organizationId, principal };
};
const options = () => ({ deadlineAt: Date.now() + 30_000 });

test("a running session denies a catalog registration changed under the same tool ID", async () => {
  const f = await fixture();
  await withDatabase(f.env, async (database) => {
    const tool = {
      id: "crm_lookup",
      connectorId: "crm",
      description: "Lookup",
      effect: "read" as const,
      version: "v1",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      maxInputBytes: 1024,
      maxOutputBytes: 4096,
      requiresApproval: false,
      retryMode: "idempotent" as const,
      target: {
        kind: "mcp" as const,
        method: "lookup",
        url: "http://fixture.invalid/mcp",
      },
    };
    const save = (
      definition:
        | typeof tool
        | (Omit<typeof tool, "effect"> & { effect: "write" })
    ) =>
      saveAdminConnector(database, {
        organizationId: f.organizationId,
        id: "crm",
        url: tool.target.url,
        principalId: f.principal.id,
        tools: [{ id: tool.id, connectorId: tool.connectorId, definition }],
      });
    await save(tool);
    const registry = createCatalogRegistry(
      await catalogTools(database, f.organizationId),
      "local"
    );
    const entry = registry.get(id.tool(tool.id));
    assert.ok(entry);
    const registered = await Effect.runPromise(bindRegisteredTool(entry));
    const address = {
      organizationId: f.organizationId,
      agentId: id.agent("agent"),
      sessionId: id.session("session"),
      conversationId: id.conversation("conversation"),
    };
    const agent = {
      agentId: address.agentId,
      organizationId: f.organizationId,
      version: 1,
      model: "fixture/model",
      instructions: "Lookup",
      enabledToolIds: [registered.id],
      grants: [tool.id, tool.connectorId].map((resourceId) => ({
        action: "execute" as const,
        resource: {
          organizationId: f.organizationId,
          kind: "tool" as const,
          id: resourceId,
        },
      })),
    };
    assert.equal(
      (
        await publishAgentConfiguration(
          database,
          agent,
          undefined,
          {
            ...options(),
            operationId: id.operation("publish"),
            requestDigest: id.digest("publish"),
          },
          { name: "Agent", creatorPrincipalId: f.principal.id }
        )
      ).status,
      "ok"
    );
    const authority = createAgentAuthority({
      current: createCurrentAuthority(f.env),
      entitlements: createCurrentEntitlements(f.env),
      enabledModels: [agent.model],
      tools: [registered],
      checkSession: () => Effect.void,
    });
    const request = {
      address,
      context: f.context,
      pinnedAgent: agent,
      action: "execute" as const,
      resource: {
        organizationId: f.organizationId,
        kind: "tool" as const,
        id: registered.id,
      },
      tool: registered,
    };
    assert.equal(
      (await Effect.runPromise(authority.evaluate(request, options())))
        .decision,
      "allow"
    );
    await save({ ...tool, requiresApproval: true });
    assert.equal(
      (await Effect.runPromise(authority.evaluate(request, options())))
        .decision,
      "deny"
    );
    await save({
      ...tool,
      effect: "write",
      requiresApproval: true,
      version: "v2",
    });
    assert.equal(
      (await Effect.runPromise(authority.evaluate(request, options())))
        .decision,
      "deny"
    );
  });
});

test("an anonymous MCP connector stores an empty account and executes", async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (_url, init) => {
    const message = JSON.parse(String(init?.body));
    if (message.method === "notifications/initialized") {
      return Promise.resolve(new Response(null, { status: 202 }));
    }
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
    } else if (message.method === "tools/list") {
      result = {
        tools: [
          {
            name: "lookup",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
          },
        ],
      };
    } else {
      calls.push(message.params.name);
      result = { content: [{ type: "text", text: "Public evidence" }] };
    }
    return Promise.resolve(
      Response.json({ jsonrpc: "2.0", id: message.id, result })
    );
  };
  try {
    await withDatabase(f.env, async (database) => {
      const added = await createConnectorAdmin(f.env).add(
        database,
        f.organizationId,
        f.principal.id,
        { id: "public", url: "http://fixture.invalid/mcp", headers: {} }
      );
      assert.equal(added.toolCount, 1);
      const sealed = await findSealedAccount(
        database,
        f.organizationId,
        "connector:public"
      );
      assert.ok(sealed);
      const credentials = await openCredentials(
        f.env.ACCOUNT_KEY,
        { organizationId: f.organizationId, accountId: "connector:public" },
        sealed
      );
      assert.deepEqual(credentials, { headers: {}, secrets: [] });
      const registry = createCatalogRegistry(
        await catalogTools(database, f.organizationId),
        "local"
      );
      const entry = registry.get(id.tool("public_lookup"));
      assert.ok(entry);
      const tool = await Effect.runPromise(bindRegisteredTool(entry));
      const executor = createConnectorExecutor({
        registry,
        credentials: () => Promise.resolve(credentials),
      });
      const result = await Effect.runPromise(
        executor.execute(
          {
            tool,
            arguments: {},
            organizationId: f.organizationId,
            agentId: id.agent("agent"),
            runId: id.run("run"),
            context: f.context,
          },
          {
            ...options(),
            operationId: id.operation("call"),
            requestDigest: id.digest("digest"),
          }
        )
      );
      assert.deepEqual(result.output, {
        content: [{ type: "text", text: "Public evidence" }],
      });
      assert.deepEqual(calls, ["lookup"]);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
