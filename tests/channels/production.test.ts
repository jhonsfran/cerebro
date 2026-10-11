import { test } from "bun:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { Effect } from "effect";

import { createApiHandler } from "../../packages/api/src/handler";
import { createIdentityRouter } from "../../packages/api/src/routers/identity";
import { unwrap } from "../../packages/channels/src/security";
import { createChannelService } from "../../packages/channels/src/service";
import type { ProductHandlerOptions } from "../../packages/channels/src/types";
import { id } from "../../packages/contracts/src/index";
import { eq } from "../../packages/db/node_modules/drizzle-orm";
import {
  AuditProjectionConflictError,
  projectAuditEvent,
} from "../../packages/db/src/repositories/audit";
import { createIdentityRepository } from "../../packages/db/src/repositories/identity";
import {
  channelConversation,
  channelItem,
} from "../../packages/db/src/schema/agents";
import { auditEvent } from "../../packages/db/src/schema/audit";
import { organization } from "../../packages/db/src/schema/core";
import {
  identityPrincipal,
  identitySlackLink,
} from "../../packages/db/src/schema/identity";
import { createFixtureSessionService } from "./fixture-session";
import {
  array,
  createTestProduct,
  domainSnapshot,
  object,
  string,
} from "./helpers";

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
  const runs = Array.from({ length: 201 }, (_, index) =>
    id.run(`chat-run-${index}`)
  );
  const options: ProductHandlerOptions = {
    ...app.options,
    sessions: (db) => ({
      ...createFixtureSessionService(db, app.options),
      inspect: (address) =>
        Effect.succeed(
          domainSnapshot(address, {
            executions: runs.map((runId) => ({
              executionId: `execution:${runId}`,
              runIds: [runId],
            })),
            outputs: runs.map((runId, index) => ({
              answerId: `answer:${runId}`,
              citations: [],
              dependencies: {
                sourceIds: index === 200 ? [sourceId] : [],
                toolIds: [],
              },
              executionId: `execution:${runId}`,
              runId,
              runIds: [runId],
              text:
                index === 200 ? "Private company content" : "Public content",
            })),
            revision: 1,
            runs: runs.map((runId) => ({
              completedAt: 1,
              runId,
              state: "completed",
            })),
          })
        ),
    }),
  };
  await app.options.withDatabase(async (db) => {
    const identity = createIdentityRepository(db);
    await identity.setManualGrant(
      app.options.organizationId,
      principalId,
      { action: "read", resourceId: sourceId, resourceKind: "memory" },
      true
    );
    const service = createChannelService(db, options);
    await service.chatAccess("test-owner", conversationId);
    await identity.setManualGrant(
      app.options.organizationId,
      principalId,
      { action: "read", resourceId: sourceId, resourceKind: "memory" },
      false
    );
    await assert.rejects(
      service.readConversation("test-owner", conversationId),
      { status: 403 }
    );
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
          entries: [{ at: 42, description: "Run completed.", type: "audit" }],
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
        Effect.succeed(
          domainSnapshot(address, {
            executions: [{ executionId: "travel-execution", runIds: [runId] }],
            outputs: [
              {
                answerId: "travel-answer",
                citations: [
                  {
                    observedAt: 42,
                    sourceId,
                    sourceUri: "company://travel",
                    sourceVersion: "v3",
                  },
                ],
                dependencies,
                executionId: "travel-execution",
                runId,
                runIds: [runId],
                text: "Rail is permitted.",
              },
            ],
            revision: 4,
            runs: [{ completedAt: 42, runId, state: "completed" }],
            tools: [
              {
                arguments: {},
                dependencies,
                effect: "read",
                operationId: "read-travel",
                output: { found: true },
                runId,
                state: "succeeded",
                toolId: "fixture-read",
                toolVersion: "1",
              },
            ],
          })
        ),
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
  const transcriptResponse = await request(`conversations/${conversationId}`);
  const view = object(await transcriptResponse.json());
  assert.deepEqual(
    array(view.items).map((entry) => object(entry).type),
    ["tool", "output", "citation", "run"]
  );
  assert.equal(
    object(array(view.items).find((entry) => object(entry).type === "output"))
      .text,
    "Rail is permitted."
  );
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
    { at: 42, description: "Run completed.", type: "audit" },
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
});
test("production with missing adapters never returns fixture source, audit or untracked output", async () => {
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
    catalog: undefined,
    mode: "production",
    readAudit: undefined,
    readSource: undefined,
    sessions: (db) => createFixtureSessionService(db, app.options),
  });
  const missingCatalogResponse = await request("catalog");
  assert.equal(missingCatalogResponse.status, 503);
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

test("an uncertain tool outcome stays visible in the conversation", async () => {
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
  const runId = id.run("unknown-run");
  const dependencies = { sourceIds: [], toolIds: ["fixture-read"] };
  const request = configuredRequest({
    ...app.options,
    sessions: (db) => ({
      ...createFixtureSessionService(db, app.options),
      inspect: (address) =>
        Effect.succeed(
          domainSnapshot(address, {
            executions: [{ executionId: "unknown-execution", runIds: [runId] }],
            outputs: [
              {
                answerId: "unknown-answer",
                citations: [],
                dependencies,
                executionId: "unknown-execution",
                runId,
                runIds: [runId],
                text: "Check the target system.",
              },
            ],
            revision: 1,
            runs: [{ completedAt: 42, runId, state: "completed" }],
            tools: [
              {
                arguments: {},
                dependencies,
                effect: "write",
                operationId: "unknown-tool",
                output: null,
                runId,
                state: "unknown-outcome",
                toolId: "fixture-read",
                toolVersion: "1",
              },
            ],
          })
        ),
    }),
  });
  const read = await request(`conversations/${conversationId}`);
  const view = object(await read.json());
  const tool = array(view.items)
    .map(object)
    .find((entry) => entry.type === "tool");
  assert.equal(tool?.state, "unknown-outcome");
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
