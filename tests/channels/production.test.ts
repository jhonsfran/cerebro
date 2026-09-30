import { test } from "bun:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { requireChatSession } from "../../apps/server/src/chat-session";
import { createProductHandler } from "../../packages/api/src/routers/conversations";
import { createIdentityRouter } from "../../packages/api/src/routers/identity";
import { drainChannelWork } from "../../packages/channels/src/drain";
import { createFixtureSessionService } from "../../packages/channels/src/fixture-session";
import { unwrap } from "../../packages/channels/src/security";
import { createChannelService } from "../../packages/channels/src/service";
import type { ProductHandlerOptions } from "../../packages/channels/src/types";
import { id } from "../../packages/contracts/src/index";
import { eq } from "../../packages/db/node_modules/drizzle-orm";
import { createIdentityRepository } from "../../packages/db/src/repositories/identity";
import {
  channelConversation,
  channelInbox,
  channelItem,
  channelReply,
} from "../../packages/db/src/schema/agents";
import { auditEvent } from "../../packages/db/src/schema/audit";
import { session as authSession } from "../../packages/db/src/schema/auth";
import { organization } from "../../packages/db/src/schema/core";
import {
  identityPrincipal,
  identitySlackLink,
} from "../../packages/db/src/schema/identity";
import { usageReservation } from "../../packages/db/src/schema/usage";
import { array, createTestProduct, object, string } from "./helpers";

const requireFromApi = createRequire(
  new URL("../../packages/api/package.json", import.meta.url)
);
const { call } = requireFromApi("@orpc/server");
const configuredRequest = (options: ProductHandlerOptions) => {
  const handler = createProductHandler(options);
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
test("chat connections reject foreign, expired and deleted Better Auth sessions", async () => {
  const app = await createTestProduct();
  const identity = { authSessionId: crypto.randomUUID(), userId: "test-owner" };
  await app.options.withDatabase(async (database) => {
    await database.insert(authSession).values({
      expiresAt: new Date(Date.now() + 60_000),
      id: identity.authSessionId,
      token: crypto.randomUUID(),
      updatedAt: new Date(),
      userId: identity.userId,
    });
    await requireChatSession(database, identity);
    await assert.rejects(
      requireChatSession(database, { ...identity, userId: "test-other" }),
      { code: "unauthorized", status: 401 }
    );
    await database
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSession.id, identity.authSessionId));
    await assert.rejects(requireChatSession(database, identity), {
      code: "unauthorized",
      status: 401,
    });
    await database
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(authSession.id, identity.authSessionId));
    await requireChatSession(database, identity);
    await database
      .delete(authSession)
      .where(eq(authSession.id, identity.authSessionId));
    await assert.rejects(requireChatSession(database, identity), {
      code: "unauthorized",
      status: 401,
    });
  });
});

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

test("chat access denies revoked content beyond the first transcript page", async () => {
  const app = await createTestProduct();
  const setup = await app.install();
  const principalId = string(setup.principalId);
  const agent = await app.createAgent();
  const response = await app.request("/api/product/conversations", "POST", {
    agentId: string(agent.agentId),
    operationId: "chat-history-access",
  });
  const created = object(await response.json());
  const conversationId = string(created.conversationId);
  const sourceId = id.source("chat-private-source");
  await app.options.withDatabase(async (db) => {
    const identity = createIdentityRepository(db);
    await identity.setManualGrant(
      app.options.organizationId,
      principalId,
      { action: "read", resourceId: sourceId, resourceKind: "memory" },
      true
    );
    await db.insert(channelItem).values(
      Array.from({ length: 201 }, (_, index) => ({
        conversationId,
        item: {
          dependencies: {
            sourceIds: index === 200 ? [sourceId] : [],
            toolIds: [],
          },
          runId: `chat-run-${index}`,
          text: index === 200 ? "Private company content" : "Public content",
          type: "output" as const,
        },
        itemKey: `chat-history-${index}`,
        organizationId: app.options.organizationId,
      }))
    );
    const service = createChannelService(db, app.options);
    await service.chatAccess("test-owner", conversationId);
    await identity.setManualGrant(
      app.options.organizationId,
      principalId,
      { action: "read", resourceId: sourceId, resourceKind: "memory" },
      false
    );
    const firstPage = await service.readConversation(
      "test-owner",
      conversationId
    );
    assert.equal(firstPage.items.length, 200);
    await assert.rejects(service.chatAccess("test-owner", conversationId), {
      status: 403,
    });
  });
});
test("production setup requires trusted credentials and preserves the exact local owner", async () => {
  const app = await createTestProduct();
  const request = configuredRequest({
    ...app.options,
    bootstrapToken: "server-configured-test-token",
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
test("configured catalog, source and audit readers replace fixture views and deny revoked content", async () => {
  const app = await createTestProduct();
  const setupResult = await app.install();
  const principalId = string(setupResult.principalId);
  const agentResult = await app.createAgent();
  const agentId = string(agentResult.agentId);
  const conversationResponse = await app.request(
    "/api/product/conversations",
    "POST",
    {
      agentId,
      operationId: "real-content",
    }
  );
  const created = object(await conversationResponse.json());
  const conversationId = string(created.conversationId);
  const sourceId = id.source("company-source");
  const runId = id.run("real-run");
  await app.options.withDatabase(async (db) => {
    await createIdentityRepository(db).setManualGrant(
      app.options.organizationId,
      principalId,
      { action: "read", resourceId: sourceId, resourceKind: "memory" },
      true
    );
    await db
      .update(channelConversation)
      .set({
        channelId: "channel",
        kind: "slack",
        projectionState: "active",
        rootTimestamp: "123",
        slackUserId: "slack-user",
        workspaceId: "workspace",
      })
      .where(eq(channelConversation.conversationId, conversationId));
    await db.insert(identitySlackLink).values({
      id: "content-link",
      organizationId: app.options.organizationId,
      principalId,
      slackUserId: "slack-user",
      workspaceId: "workspace",
    });
  });
  const dependencies = { sourceIds: [sourceId], toolIds: ["fixture-read"] };
  let sourceCalls = 0;
  let auditCalls = 0;
  let deliveries = 0;
  const options: ProductHandlerOptions = {
    ...app.options,
    catalog: {
      connectorChoices: [{ id: "fixture-read", label: "Configured read tool" }],
      modelChoices: [{ id: "configured/model", label: "Configured model" }],
    },
    catalogFor: (_db, context) => {
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
    checkContentDependencies: () =>
      Promise.resolve({ status: "ok", value: undefined }),
    readAudit: (_db, _context, input) => {
      auditCalls += 1;
      assert.equal(input.sessionId, created.sessionId);
      return Promise.resolve({
        status: "ok",
        value: {
          entries: [
            { at: 42, description: "Provider usage settled.", type: "usage" },
          ],
          runId: input.runId,
          state: "completed",
        },
      });
    },
    readSource: (_db, context, input) => {
      sourceCalls += 1;
      assert.equal(context.actor.id, principalId);
      assert.equal(input.sessionId, created.sessionId);
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
    sessions: (db) => ({
      ...createFixtureSessionService(db, app.options),
      inspect: (address) =>
        Promise.resolve({
          status: "ok",
          value: {
            address,
            agentVersion: 1,
            cursor: "4",
            runs: [{ completedAt: 42, runId, state: "completed" }],
          },
        }),
      async *stream() {
        yield {
          status: "ok",
          value: {
            cursor: "1",
            dependencies,
            runId,
            text: "Rail is permitted.",
            type: "output",
          },
        };
        yield {
          status: "ok",
          value: {
            citation: {
              observedAt: 42,
              sourceId,
              sourceUri: "company://travel",
              sourceVersion: "v3",
            },
            cursor: "2",
            dependencies,
            runId,
            type: "citation",
          },
        };
        yield {
          status: "ok",
          value: {
            cursor: "3",
            dependencies,
            operationId: id.operation("read-travel"),
            output: { found: true },
            runId,
            toolId: "fixture-read",
            type: "tool",
          },
        };
        yield {
          status: "ok",
          value: {
            cursor: "4",
            run: { completedAt: 42, runId, state: "completed" },
            type: "run",
          },
        };
      },
    }),
  };
  const request = configuredRequest(options);
  const catalogResponse = await request("catalog");
  assert.deepEqual(object(await catalogResponse.json()).modelChoices, [
    { id: "configured/model", label: "Configured model" },
  ]);
  const unknownModelResponse = await request("agents", "POST", {
    ...app.agentBody,
    model: "unknown",
    operationId: "unknown",
  });
  assert.equal(unknownModelResponse.status, 422);
  const selectedGrants = [
    {
      action: "read",
      resource: {
        id: "fixture-read",
        kind: "tool",
        organizationId: app.options.organizationId,
      },
    },
    {
      action: "execute",
      resource: {
        id: "fixture-read",
        kind: "tool",
        organizationId: app.options.organizationId,
      },
    },
    {
      action: "read",
      resource: {
        id: sourceId,
        kind: "memory",
        organizationId: app.options.organizationId,
      },
    },
  ];
  const configuredAgentBody = {
    ...app.agentBody,
    grants: selectedGrants,
    model: "configured/model",
    operationId: "configured",
  };
  const publishedAgentResponse = await request(
    "agents",
    "POST",
    configuredAgentBody
  );
  assert.equal(publishedAgentResponse.status, 200);
  const published = object(await publishedAgentResponse.json());
  const configuredAgentResponse = await request(
    `agents/${string(published.agentId)}`
  );
  const configuredAgent = object(await configuredAgentResponse.json());
  assert.deepEqual(object(configuredAgent.definition).grants, selectedGrants);
  assert.deepEqual(configuredAgent.sourceChoices, [
    { id: "company-source", label: "Company policy" },
  ]);
  await drainChannelWork(options);
  const transcriptResponse = await request(`conversations/${conversationId}`);
  const view = object(await transcriptResponse.json());
  assert.deepEqual(
    array(view.items).map((entry) => object(entry).type),
    ["output", "citation", "tool", "run"]
  );
  assert.equal(object(array(view.items)[0]).text, "Rail is permitted.");
  const sourceResponse = await request(
    `conversations/${conversationId}/sources/${sourceId}`
  );
  assert.equal(
    object(await sourceResponse.json()).text,
    "Company travel policy permits rail."
  );
  const auditResponse = await request(
    `conversations/${conversationId}/audit/${runId}`
  );
  assert.deepEqual(object(await auditResponse.json()).entries, [
    { at: 42, description: "Provider usage settled.", type: "usage" },
  ]);
  assert.equal(sourceCalls, 1);
  assert.equal(auditCalls, 1);
  await app.options.withDatabase((db) =>
    createIdentityRepository(db).setManualGrant(
      app.options.organizationId,
      principalId,
      { action: "read", resourceId: sourceId, resourceKind: "memory" },
      false
    )
  );
  const revokedTranscriptResponse = await request(
    `conversations/${conversationId}`
  );
  assert.equal(revokedTranscriptResponse.status, 403);
  const revokedSourceResponse = await request(
    `conversations/${conversationId}/sources/${sourceId}`
  );
  assert.equal(revokedSourceResponse.status, 403);
  assert.equal(sourceCalls, 1);
  const revokedPublication = await request(
    "agents",
    "POST",
    configuredAgentBody
  );
  assert.equal(revokedPublication.status, 403);
  await drainChannelWork({
    ...options,
    fetch: () => {
      deliveries += 1;
      return Promise.resolve(
        Response.json({ channel: "channel", ok: true, ts: "124" })
      );
    },
    slack: {
      agentId,
      appId: "app",
      botToken: "test",
      signingSecret: "test",
      workspaceId: "workspace",
    },
  });
  assert.equal(deliveries, 0);
  await app.options.withDatabase(async (db) => {
    const queuedReplies = await db.select().from(channelReply);
    assert.equal(queuedReplies[0]?.state, "failed");
  });
});
test("production with missing adapters never returns fixture source, audit, budget or untracked output", async () => {
  const app = await createTestProduct();
  await app.install();
  const agentResult = await app.createAgent();
  const agentId = string(agentResult.agentId);
  const conversationResponse = await app.request(
    "/api/product/conversations",
    "POST",
    {
      agentId,
      operationId: "missing-adapters",
    }
  );
  const conversationId = string(
    object(await conversationResponse.json()).conversationId
  );
  const request = configuredRequest({
    ...app.options,
    mode: "production",
    sessions: (db) => createFixtureSessionService(db, app.options),
  });
  const missingCatalogResponse = await request("catalog");
  assert.equal(missingCatalogResponse.status, 503);
  const missingBudgetResponse = await request("budget");
  assert.equal(missingBudgetResponse.status, 503);
  const missingSourceResponse = await request(
    `conversations/${conversationId}/sources/pilot-source`
  );
  assert.equal(missingSourceResponse.status, 503);
  const missingAuditResponse = await request(
    `conversations/${conversationId}/audit/missing-run`
  );
  assert.equal(missingAuditResponse.status, 503);
  await app.options.withDatabase((db) =>
    db.insert(channelItem).values({
      conversationId,
      item: {
        runId: "untracked-run",
        text: "Private generated answer",
        type: "output",
      },
      itemKey: "untracked",
      organizationId: app.options.organizationId,
    })
  );
  const untrackedOutputResponse = await request(
    `conversations/${conversationId}`
  );
  assert.equal(untrackedOutputResponse.status, 403);
  assert.throws(
    () =>
      unwrap({
        code: "budget-exhausted",
        reason: "No budget remains.",
        status: "denied",
      }),
    { code: "budget-exhausted", status: 403 }
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
test("audit and usage exports require current export grants and return bounded company rows", async () => {
  const app = await createTestProduct();
  const setupResult = await app.install();
  const principalId = string(setupResult.principalId);
  const otherCompanyId = `other-export-company-${crypto.randomUUID()}`;
  await app.options.withDatabase(async (db) => {
    await db
      .delete(auditEvent)
      .where(eq(auditEvent.organizationId, app.options.organizationId));
    await db
      .delete(usageReservation)
      .where(eq(usageReservation.organizationId, app.options.organizationId));
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
    await db.insert(usageReservation).values(
      ["usage-a", "usage-b", "usage-other"].map((reservationId) => ({
        id: reservationId,
        incurred: 3,
        maximum: 5,
        operationId: reservationId,
        organizationId:
          reservationId === "usage-other"
            ? otherCompanyId
            : app.options.organizationId,
        state: "settled" as const,
        unit: "credits",
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
    await Promise.all(
      (["audit", "budget"] as const).map((resourceKind) =>
        identity.setManualGrant(
          app.options.organizationId,
          principalId,
          {
            action: "export",
            resourceId: app.options.organizationId,
            resourceKind,
          },
          true
        )
      )
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
    const usage = await call(
      router.exportData,
      { kind: "usage", limit: 200, organizationId: app.options.organizationId },
      { context }
    );
    assert.deepEqual(
      usage.records.map((row: { id: string; incurred: number }) => [
        row.id,
        row.incurred,
      ]),
      [
        ["usage-a", 3],
        ["usage-b", 3],
      ]
    );
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
        { kind: "usage", organizationId: otherCompanyId },
        { context }
      ),
      { code: "FORBIDDEN" }
    );
  });
});

test("unknown tool outcomes finish channel projection and remain visible for reconciliation", async () => {
  const app = await createTestProduct();
  await app.install();
  const agent = await app.createAgent();
  const agentId = string(agent.agentId);
  const response = await app.request("/api/product/conversations", "POST", {
    agentId,
    operationId: "unknown-projection",
  });
  const conversation = object(await response.json());
  const conversationId = string(conversation.conversationId);
  const run = {
    operationId: id.operation("unknown-tool"),
    runId: id.run("unknown-run"),
    state: "unknown-outcome" as const,
  };
  await app.options.withDatabase((db) =>
    db
      .update(channelConversation)
      .set({ projectionState: "active" })
      .where(eq(channelConversation.conversationId, conversationId))
  );
  await drainChannelWork({
    ...app.options,
    sessions: (db) => ({
      ...createFixtureSessionService(db, app.options),
      inspect: (address) =>
        Promise.resolve({
          status: "ok",
          value: { address, agentVersion: 1, cursor: "1", runs: [run] },
        }),
      async *stream() {
        yield { status: "ok", value: { cursor: "1", run, type: "run" } };
      },
    }),
  });
  await app.options.withDatabase(async (db) => {
    const [projection] = await db
      .select()
      .from(channelConversation)
      .where(eq(channelConversation.conversationId, conversationId));
    assert.equal(projection?.projectionState, "idle");
    const [item] = await db
      .select()
      .from(channelItem)
      .where(eq(channelItem.conversationId, conversationId));
    assert.deepEqual(item?.item, { run, runId: "unknown-run", type: "run" });
  });
});

test("empty runtime sessions become idle but pending or accepted admissions remain active", async () => {
  const app = await createTestProduct();
  await app.install();
  const agent = await app.createAgent();
  const response = await app.request("/api/product/conversations", "POST", {
    agentId: string(agent.agentId),
    operationId: "empty-projection",
  });
  const conversation = object(await response.json());
  const conversationId = string(conversation.conversationId);
  const options: ProductHandlerOptions = {
    ...app.options,
    sessions: (db) => ({
      ...createFixtureSessionService(db, app.options),
      inspect: (address) =>
        Promise.resolve({
          status: "ok",
          value: {
            address,
            agentVersion: 0,
            cursor: "0",
            runs: [],
          },
        }),
      async *stream() {},
      submit: () =>
        Promise.resolve({
          code: "provider-unavailable",
          reason: "Admission delayed.",
          status: "unavailable",
        }),
    }),
  };
  await drainChannelWork(options);
  await app.options.withDatabase(async (db) => {
    const [projection] = await db
      .select()
      .from(channelConversation)
      .where(eq(channelConversation.conversationId, conversationId));
    assert.equal(projection?.projectionState, "idle");
    assert.equal(projection?.streamCursor, null);
    const items = await db
      .select()
      .from(channelItem)
      .where(eq(channelItem.conversationId, conversationId));
    assert.deepEqual(items, []);
  });
  const request = configuredRequest(options);
  const admission = await request(
    `conversations/${encodeURIComponent(conversationId)}/messages`,
    "POST",
    {
      eventId: "delayed-empty-admission",
      text: "Wait for admission.",
    }
  );
  assert.equal(admission.status, 503);
  await drainChannelWork(options);
  await app.options.withDatabase(async (db) => {
    const [pending] = await db
      .select()
      .from(channelConversation)
      .where(eq(channelConversation.conversationId, conversationId));
    assert.equal(pending?.projectionState, "active");
    await db
      .update(channelInbox)
      .set({ state: "accepted" })
      .where(eq(channelInbox.conversationId, conversationId));
  });
  await drainChannelWork(options);
  await app.options.withDatabase(async (db) => {
    const [accepted] = await db
      .select()
      .from(channelConversation)
      .where(eq(channelConversation.conversationId, conversationId));
    assert.equal(accepted?.projectionState, "active");
  });
});

test("local Slack delivery denies a queued reply without an authorized output projection", async () => {
  let delivered = 0;
  const app = await createTestProduct();
  const setup = await app.install();
  const principalId = string(setup.principalId);
  const agent = await app.createAgent();
  const agentId = string(agent.agentId);
  const createdResponse = await app.request(
    "/api/product/conversations",
    "POST",
    { agentId, operationId: "missing-local-output" }
  );
  assert.equal(createdResponse.status, 200);
  const created = object(await createdResponse.json());
  const conversationId = string(created.conversationId);
  await app.options.withDatabase(async (db) => {
    await db
      .update(channelConversation)
      .set({
        channelId: "channel",
        kind: "slack",
        projectionState: "idle",
        rootTimestamp: "123",
        slackUserId: "slack-user",
        workspaceId: "workspace",
      })
      .where(eq(channelConversation.conversationId, conversationId));
    await db.insert(identitySlackLink).values({
      id: "local-output-link",
      organizationId: app.options.organizationId,
      principalId,
      slackUserId: "slack-user",
      workspaceId: "workspace",
    });
    await db.insert(channelReply).values({
      conversationId,
      organizationId: app.options.organizationId,
      replyId: "missing-output-reply",
      runId: "missing-output-run",
      state: "ready",
      text: "Private untracked output",
    });
  });
  const result = await drainChannelWork({
    ...app.options,
    fetch: () => {
      delivered += 1;
      return Promise.resolve(
        Response.json({ channel: "channel", ok: true, ts: "124" })
      );
    },
    mode: "local",
    slack: {
      agentId,
      appId: "app",
      botToken: "test",
      signingSecret: "test",
      workspaceId: "workspace",
    },
  });
  assert.equal(result.sent, 0);
  assert.equal(delivered, 0);
  await app.options.withDatabase(async (db) => {
    const [reply] = await db.select().from(channelReply);
    assert.equal(reply.state, "failed");
    assert.deepEqual(reply.providerReceipt, {
      reason: "Current authorization denied reply delivery.",
    });
  });
});
