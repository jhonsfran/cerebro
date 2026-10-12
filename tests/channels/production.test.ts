/* oxlint-disable unicorn/no-await-expression-member -- Assertions inspect the preceding native response. */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { createApiHandler } from "../../packages/api/src/handler";
import { createIdentityRouter } from "../../packages/api/src/routers/identity";
import { unwrap } from "../../packages/channels/src/security";
import { createChannelService } from "../../packages/channels/src/service";
import type { ProductHandlerOptions } from "../../packages/channels/src/types";
import { eq } from "../../packages/db/node_modules/drizzle-orm";
import {
  AuditProjectionConflictError,
  projectAuditEvent,
} from "../../packages/db/src/repositories/audit";
import { createIdentityRepository } from "../../packages/db/src/repositories/identity";
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
