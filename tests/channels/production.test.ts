/* oxlint-disable unicorn/no-await-expression-member -- Assertions inspect the preceding native response. */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import type { WorkerEnv } from "../../apps/server/src/bindings";
import { createSessionClient } from "../../apps/server/src/session/client";
import { authenticateSessionRequest } from "../../apps/server/src/session/proof";
import { createApiHandler } from "../../packages/api/src/handler";
import { createIdentityRouter } from "../../packages/api/src/routers/identity";
import { unwrap } from "../../packages/channels/src/security";
import { createChannelService } from "../../packages/channels/src/service";
import type { ProductHandlerOptions } from "../../packages/channels/src/types";
import type { EventAddress } from "../../packages/contracts/src/events";
import { Denied } from "../../packages/contracts/src/failures";
import { id } from "../../packages/contracts/src/identity";
import type { ExecutionContext } from "../../packages/contracts/src/identity";
import { eq } from "../../packages/db/node_modules/drizzle-orm";
import {
  AuditProjectionConflictError,
  projectAuditEvent,
} from "../../packages/db/src/repositories/audit";
import { createIdentityRepository } from "../../packages/db/src/repositories/identity";
import { channelConversation } from "../../packages/db/src/schema/agents";
import { auditEvent } from "../../packages/db/src/schema/audit";
import { organization } from "../../packages/db/src/schema/core";
import { identityPrincipal } from "../../packages/db/src/schema/identity";
import { createTestProduct, object, string } from "./helpers";

const requireFromApi = createRequire(
  new URL("../../packages/api/package.json", import.meta.url)
);
const { call } = requireFromApi("@orpc/server");
const configuredRequest = (options: ProductHandlerOptions) => {
  const handler = createApiHandler(options);
  return (
    path: string,
    method = "GET",
    body?: unknown,
    userId = "test-owner"
  ) =>
    handler(
      new Request(`http://cerebro.test/api/product/${path}`, {
        headers: { "Content-Type": "application/json", "x-test-user": userId },
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    );
};
test("chat access checks the conversation owner and current agent read access", async () => {
  const app = await createTestProduct();
  const setup = await app.install();
  const principalId = string(setup.principalId);
  const agent = await app.createAgent();
  const agentId = string(agent.agentId);
  const response = await app.request("/api/product/conversations", "POST", {
    agentId,
    operationId: "chat-access",
  });
  const created = object(await response.json());
  const conversationId = string(created.conversationId);
  await app.options.withDatabase(async (db) => {
    const service = createChannelService(db, app.options);
    const access = await service.chatAccess("test-owner", conversationId);
    assert.deepEqual(access.address, {
      agentId,
      conversationId,
      organizationId: app.options.organizationId,
      sessionId: created.sessionId,
    });
    assert.equal(access.context.actor.id, principalId);
    await createIdentityRepository(db).provisionHumanPrincipal(
      app.options.organizationId,
      "test-other"
    );
    await assert.rejects(service.chatAccess("test-other", conversationId), {
      status: 404,
    });
    await createIdentityRepository(db).setManualGrant(
      app.options.organizationId,
      principalId,
      { action: "read", resourceId: agentId, resourceKind: "agent" },
      false
    );
    await assert.rejects(service.chatAccess("test-owner", conversationId), {
      status: 403,
    });
  });
});

test("the production gateway derives identity placement from the exact active conversation record", async () => {
  const app = await createTestProduct();
  const setup = await app.install();
  const firstAgent = await app.createAgent();
  const secondAgent = object(
    await (
      await app.request("/api/product/agents", "POST", {
        ...app.agentBody,
        name: "Second agent",
        operationId: "second-agent",
      })
    ).json()
  );
  const created = await Promise.all(
    [firstAgent, secondAgent].map(async (agent, index) =>
      object(
        await (
          await app.request("/api/product/conversations", "POST", {
            agentId: string(agent.agentId),
            operationId: `placement-${index}`,
          })
        ).json()
      )
    )
  );
  const ownerPrincipalId = string(setup.principalId);
  const addresses: EventAddress[] = created.map((conversation) => ({
    agentId: id.agent(string(conversation.agentId)),
    conversationId: id.conversation(string(conversation.conversationId)),
    organizationId: id.organization(app.options.organizationId),
    sessionId: id.session(string(conversation.sessionId)),
  }));
  const [first, second] = addresses;
  assert.ok(first);
  assert.ok(second);
  const otherOwner = {
    ...first,
    conversationId: id.conversation("placement-other-owner"),
    sessionId: id.session("placement-other-owner"),
  };
  const otherOrganization = {
    ...first,
    organizationId: id.organization("placement-other-organization"),
    conversationId: id.conversation("placement-other-organization"),
    sessionId: id.session("placement-other-organization"),
  };
  await app.options.withDatabase((db) =>
    db.insert(channelConversation).values([
      {
        ...otherOwner,
        bindingKey: "placement:other-owner",
        engine: "pi-identity-v1",
        kind: "web",
        ownerPrincipalId: "other-principal",
      },
      {
        ...otherOrganization,
        bindingKey: "placement:other-organization",
        engine: "pi-identity-v1",
        kind: "web",
        ownerPrincipalId,
      },
    ])
  );

  const secret = "private-gateway-routing-test-value-with-32-characters";
  const captured: { readonly name: string; readonly request: Request }[] = [];
  const environment = {
    DATABASE_URL: process.env.CHANNEL_TEST_DATABASE_URL,
    DEPLOY_MODE: "local",
    RUNTIME_CONFIG_JSON: JSON.stringify({
      artifacts: {
        accessKeyId: "fixture",
        bucket: "fixture",
        endpoint: "http://fixture:9000",
        region: "test",
        secretAccessKey: "fixture",
      },
      bootstrapToken: "private-setup-routing-test-value-with-32-characters",
      gatewaySigningKey: secret,
      mode: "local",
      models: [
        {
          apiKey: "fixture",
          baseUrl: "http://fixture:8090/v1",
          deadlineMs: 1000,
          id: "fixture/model",
          maxInputBytes: 4096,
          maxOutputTokens: 128,
          maxResponseBytes: 4096,
          model: "model",
          provider: "fixture",
        },
      ],
      retrievalMode: "full-text",
      tools: [],
    }),
    SESSION: {
      get: (name: string) => ({
        fetch: async (request: Request) => {
          captured.push({ name, request });
          const command = object(await request.clone().json());
          const route = new URL(request.url).pathname;
          if (route === "/control") {
            const control = object(command.command);
            return Response.json({
              status: "ok",
              value: {
                id: `native:${control.operationId}`,
                kind: control.kind,
              },
            });
          }
          if (route === "/fork") {
            return Response.json({
              status: "ok",
              value: { address: command.destination },
            });
          }
          return Response.json({
            status: "ok",
            value: {
              accepted: true,
              operationId: command.operationId,
              session: "native-session",
            },
          });
        },
      }),
      idFromName: (name: string) => name,
    },
  };
  const client = createSessionClient(environment as unknown as WorkerEnv);
  const caller: ExecutionContext = {
    actor: {
      id: id.principal(ownerPrincipalId),
      kind: "human",
      organizationId: first.organizationId,
      state: "active",
    },
  };
  const send = (address: EventAddress, context = caller) =>
    client.send({
      address,
      context,
      operationId: "same-input",
      text: "Route this input.",
    });
  await Promise.all(
    [first, second, otherOwner, otherOrganization].map((address) =>
      send(address)
    )
  );
  const claimedActor: ExecutionContext = {
    actor: { ...caller.actor, id: id.principal("caller-cannot-select-host") },
  };
  await send(first, claimedActor);
  const calls = await Promise.all(
    captured.map(async (capturedRequest) => ({
      name: capturedRequest.name,
      resolved: await authenticateSessionRequest(
        capturedRequest.request.clone(),
        secret,
        {
          organizationId: JSON.parse(capturedRequest.name)[0],
          ownerPrincipalId: JSON.parse(capturedRequest.name)[1],
        }
      ),
    }))
  );
  const byConversation = (conversationId: string) =>
    calls.find(
      (capturedRequest) =>
        capturedRequest.resolved.address.conversationId === conversationId
    )?.name;
  assert.equal(
    byConversation(first.conversationId),
    JSON.stringify([first.organizationId, ownerPrincipalId])
  );
  assert.equal(
    byConversation(second.conversationId),
    byConversation(first.conversationId)
  );
  assert.equal(
    byConversation(otherOwner.conversationId),
    JSON.stringify([first.organizationId, "other-principal"])
  );
  assert.equal(
    byConversation(otherOrganization.conversationId),
    JSON.stringify([otherOrganization.organizationId, ownerPrincipalId])
  );
  assert.equal(calls.at(-1)?.name, byConversation(first.conversationId));
  assert.equal(calls.at(-1)?.resolved.context.actor.id, claimedActor.actor.id);

  const destination = {
    ...first,
    conversationId: id.conversation("placement-fork"),
    sessionId: id.session("placement-fork"),
  };
  await app.options.withDatabase((db) =>
    db.insert(channelConversation).values({
      ...destination,
      bindingKey: "placement:fork",
      engine: "pi-identity-v1",
      forkOrigin: {
        agentVersion: 1,
        entryId: "12",
        parentConversationId: first.conversationId,
        parentSessionId: first.sessionId,
      },
      kind: "web",
      ownerPrincipalId,
    })
  );
  const control = {
    instructions: "Keep decisions.",
    kind: "compact" as const,
    operationId: "compact-transport",
  };
  assert.deepEqual(
    await client.control({ address: first, command: control, context: caller }),
    { id: "native:compact-transport", kind: "compact" }
  );
  assert.deepEqual(
    await client.fork({
      address: first,
      context: caller,
      destination,
      entryId: "12",
      operationId: "fork-transport",
    }),
    { address: destination }
  );
  const commands = captured.slice(-2);
  assert.deepEqual(
    await Promise.all(
      commands.map(async (capturedRequest) => ({
        body: await capturedRequest.request.clone().json(),
        name: capturedRequest.name,
        resolved: await authenticateSessionRequest(
          capturedRequest.request.clone(),
          secret,
          {
            organizationId: first.organizationId,
            ownerPrincipalId: id.principal(ownerPrincipalId),
          }
        ),
      }))
    ),
    [
      {
        body: { command: control },
        name: JSON.stringify([first.organizationId, ownerPrincipalId]),
        resolved: { address: first, context: caller },
      },
      {
        body: { destination, entryId: "12", operationId: "fork-transport" },
        name: JSON.stringify([first.organizationId, ownerPrincipalId]),
        resolved: { address: first, context: caller },
      },
    ]
  );

  const dispatched = captured.length;
  await Promise.all(
    [
      { ...first, agentId: id.agent("wrong-agent") },
      { ...first, conversationId: id.conversation("wrong-conversation") },
      { ...first, organizationId: id.organization("wrong-organization") },
      { ...first, sessionId: id.session("wrong-session") },
    ].map((changed) => assert.rejects(send(changed), Denied))
  );
  await assert.rejects(
    client.control({
      address: { ...first, sessionId: id.session("forged-source") },
      command: control,
      context: caller,
    }),
    Denied
  );
  await assert.rejects(
    client.fork({
      address: { ...first, conversationId: id.conversation("forged-source") },
      context: caller,
      destination,
      entryId: "12",
      operationId: "forged-fork",
    }),
    Denied
  );
  await app.options.withDatabase((db) =>
    db
      .update(channelConversation)
      .set({ engine: "pi-v1" })
      .where(eq(channelConversation.conversationId, first.conversationId))
  );
  await assert.rejects(send(first), Denied);
  await app.options.withDatabase((db) =>
    db
      .update(channelConversation)
      .set({ engine: "pi-identity-v1", retiredAt: new Date() })
      .where(eq(channelConversation.conversationId, first.conversationId))
  );
  await assert.rejects(send(first), Denied);
  assert.equal(captured.length, dispatched);
});

test("production setup requires trusted credentials and preserves the exact local owner", async () => {
  const app = await createTestProduct();
  const request = configuredRequest({
    ...app.options,
    bootstrapToken: "server-configured-test-token",
    catalog: undefined,
    mode: "production",
  });
  const setupResponse = await request("setup");
  const initial = object(await setupResponse.json());
  assert.equal(initial.setupRequired, true);
  assert.equal(initial.bootstrapTokenRequired, true);
  const missingTokenResponse = await request("setup", "POST", {
    operationId: "setup",
  });
  assert.equal(missingTokenResponse.status, 403);
  const invalidTokenResponse = await request("setup", "POST", {
    bootstrapToken: "wrong",
    operationId: "setup",
  });
  assert.equal(invalidTokenResponse.status, 403);
  const trustedSetupResponse = await request("setup", "POST", {
    bootstrapToken: "server-configured-test-token",
    operationId: "setup",
  });
  assert.equal(trustedSetupResponse.status, 200);
  const ownerReplayResponse = await request("setup", "POST", {
    operationId: "replay",
  });
  assert.equal(ownerReplayResponse.status, 200);
  const otherOwnerResponse = await request(
    "setup",
    "POST",
    {
      bootstrapToken: "server-configured-test-token",
      operationId: "other",
    },
    "test-other"
  );
  assert.equal(otherOwnerResponse.status, 403);
  const missingCatalogResponse = await request("catalog");
  assert.equal(missingCatalogResponse.status, 503);
});
test("production setup does not convert a directory-managed human into local owner", async () => {
  const app = await createTestProduct();
  await app.options.withDatabase(async (db) => {
    await db
      .insert(organization)
      .values({ id: app.options.organizationId, name: "Company" })
      .onConflictDoNothing();
    const principal = await createIdentityRepository(
      db
    ).provisionHumanPrincipal(app.options.organizationId, "test-owner");
    await db
      .update(identityPrincipal)
      .set({ directoryManaged: true })
      .where(eq(identityPrincipal.id, principal.id));
  });
  const request = configuredRequest({
    ...app.options,
    mode: "production",
    trustedOwnerUserId: "test-owner",
  });
  const managedOwnerResponse = await request("setup", "POST", {
    operationId: "setup",
  });
  assert.equal(managedOwnerResponse.status, 403);
});

test("configured catalog and source readers enforce current company grants", async () => {
  const app = await createTestProduct();
  const setup = await app.install();
  const principalId = string(setup.principalId);
  const agent = await app.createAgent();
  const created = await app.request("/api/product/conversations", "POST", {
    agentId: string(agent.agentId),
    operationId: "configured-source",
  });
  const conversationId = string(object(await created.json()).conversationId);
  await app.options.withDatabase((db) =>
    createIdentityRepository(db).setManualGrant(
      app.options.organizationId,
      principalId,
      { action: "read", resourceId: "company-source", resourceKind: "memory" },
      true
    )
  );
  let sourceCalls = 0;
  const request = configuredRequest({
    ...app.options,
    catalogFor: (_database, context) => {
      assert.equal(context.actor.id, principalId);
      return Promise.resolve({
        status: "ok",
        value: {
          connectorChoices: [
            { id: "fixture-read", label: "Configured read tool" },
          ],
          modelChoices: [{ id: "configured/model", label: "Configured model" }],
          sourceChoices: [{ id: "company-source", label: "Company policy" }],
        },
      });
    },
    readSource: (_database, context, input) => {
      sourceCalls += 1;
      assert.equal(context.actor.id, principalId);
      return Promise.resolve({
        status: "ok",
        value: {
          sourceId: input.sourceId,
          sourceVersion: "v3",
          text: "Company travel policy permits rail.",
          title: "Company document",
        },
      });
    },
  });
  const catalog = object(await (await request("catalog")).json());
  assert.deepEqual(catalog.modelChoices, [
    { id: "configured/model", label: "Configured model" },
  ]);
  assert.equal(
    (
      await request("agents", "POST", {
        ...app.agentBody,
        model: "unknown",
        operationId: "unknown-model",
      })
    ).status,
    422
  );
  const grants = [
    {
      action: "read",
      resource: {
        id: "company-source",
        kind: "memory",
        organizationId: app.options.organizationId,
      },
    },
  ];
  const body = {
    ...app.agentBody,
    grants,
    model: "configured/model",
    operationId: "configured-agent",
  };
  const published = await request("agents", "POST", body);
  assert.equal(published.status, 200);
  const publishedAgent = object(await published.json());
  const definition = object(
    await (await request(`agents/${string(publishedAgent.agentId)}`)).json()
  );
  assert.deepEqual(object(definition.definition).grants, grants);
  const route = `conversations/${conversationId}/sources/company-source`;
  assert.equal(
    object(await (await request(route)).json()).text,
    "Company travel policy permits rail."
  );
  await app.options.withDatabase((db) =>
    createIdentityRepository(db).setManualGrant(
      app.options.organizationId,
      principalId,
      { action: "read", resourceId: "company-source", resourceKind: "memory" },
      false
    )
  );
  assert.equal((await request(route)).status, 403);
  assert.equal((await request("agents", "POST", body)).status, 403);
  assert.equal(sourceCalls, 1);
});

test("production requires configured catalog and source adapters", async () => {
  const app = await createTestProduct();
  await app.install();
  const agent = await app.createAgent();
  const created = await app.request("/api/product/conversations", "POST", {
    agentId: string(agent.agentId),
    operationId: "missing-adapters",
  });
  const conversationId = string(object(await created.json()).conversationId);
  const request = configuredRequest({
    ...app.options,
    catalog: undefined,
    mode: "production",
    readSource: undefined,
  });
  assert.equal((await request("catalog")).status, 503);
  assert.equal(
    (await request(`conversations/${conversationId}/sources/pilot-source`))
      .status,
    503
  );
  assert.throws(
    () =>
      unwrap({
        code: "provider-unavailable",
        reason: "The provider is down.",
        status: "unavailable",
      }),
    { code: "provider-unavailable", status: 503 }
  );
});

test("audit export requires a current export grant and returns bounded company rows", async () => {
  const app = await createTestProduct();
  const setupResult = await app.install();
  const principalId = string(setupResult.principalId);
  const otherCompanyId = `other-export-company-${crypto.randomUUID()}`;
  await app.options.withDatabase(async (db) => {
    await db
      .delete(auditEvent)
      .where(eq(auditEvent.organizationId, app.options.organizationId));
    await db
      .insert(organization)
      .values({ id: otherCompanyId, name: "Other" })
      .onConflictDoNothing();
    await db.insert(auditEvent).values(
      ["a", "b", "other"].map((eventId) => ({
        agentId: "agent",
        eventId,
        kind: "audit",
        name: "run.completed",
        occurredAt: new Date(42),
        organizationId:
          eventId === "other" ? otherCompanyId : app.options.organizationId,
        payload: { eventId },
        runId: "run",
        sessionId: "session",
      }))
    );
    const context = { db, session: { user: { id: "test-owner" } } };
    const router = createIdentityRouter();
    await assert.rejects(
      call(
        router.exportData,
        { kind: "audit", limit: 1, organizationId: app.options.organizationId },
        { context }
      ),
      { code: "FORBIDDEN" }
    );
    const identity = createIdentityRepository(db);
    await identity.setManualGrant(
      app.options.organizationId,
      principalId,
      {
        action: "export",
        resourceId: app.options.organizationId,
        resourceKind: "audit",
      },
      true
    );
    const first = await call(
      router.exportData,
      { kind: "audit", limit: 1, organizationId: app.options.organizationId },
      { context }
    );
    assert.deepEqual(
      first.records.map((row: { eventId: string }) => row.eventId),
      ["a"]
    );
    assert.equal(first.nextCursor, "a");
    const second = await call(
      router.exportData,
      {
        cursor: first.nextCursor,
        kind: "audit",
        limit: 1,
        organizationId: app.options.organizationId,
      },
      { context }
    );
    assert.deepEqual(
      second.records.map((row: { eventId: string }) => row.eventId),
      ["b"]
    );
    assert.equal(second.nextCursor, null);
    await identity.setManualGrant(
      app.options.organizationId,
      principalId,
      {
        action: "export",
        resourceId: app.options.organizationId,
        resourceKind: "audit",
      },
      false
    );
    await assert.rejects(
      call(
        router.exportData,
        { kind: "audit", organizationId: app.options.organizationId },
        { context }
      ),
      { code: "FORBIDDEN" }
    );
    await assert.rejects(
      call(
        router.exportData,
        { kind: "audit", organizationId: otherCompanyId },
        { context }
      ),
      { code: "FORBIDDEN" }
    );
  });
});

test("audit projection stores a replayed event once and rejects a changed one", async () => {
  const app = await createTestProduct();
  const event = {
    agentId: "agent-audit",
    eventId: `audit-replay:${crypto.randomUUID()}`,
    kind: "audit" as const,
    name: "run.completed",
    occurredAt: 1_800_000_000_000,
    organizationId: app.options.organizationId,
    payload: { state: "completed" },
    runId: "run-audit",
    sessionId: "session-audit",
  };
  await app.options.withDatabase(async (db) => {
    await projectAuditEvent(db, event);
    await projectAuditEvent(db, event);
    const rows = await db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.eventId, event.eventId));
    assert.equal(rows.length, 1);
    await assert.rejects(
      projectAuditEvent(db, { ...event, name: "run.changed" }),
      AuditProjectionConflictError
    );
  });
});
