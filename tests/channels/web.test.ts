import { test } from "bun:test";
import assert from "node:assert/strict";

import { drainChannelWork } from "../../packages/channels/src/drain";
import { createFixtureSessionService } from "../../packages/channels/src/fixture-session";
import { id } from "../../packages/contracts/src/index";
import { and, eq } from "../../packages/db/node_modules/drizzle-orm";
import { createAgentRepository } from "../../packages/db/src/repositories/agents";
import { createIdentityRepository } from "../../packages/db/src/repositories/identity";
import {
  channelConversation,
  channelFixtureRun,
  channelInbox,
  channelItem,
} from "../../packages/db/src/schema/agents";
import { identityGrant } from "../../packages/db/src/schema/identity";
import { array, createTestProduct, object, string } from "./helpers";

test("fixture setup chooses one owner and production rejects fixture adapters", async () => {
  const app = await createTestProduct();
  const responses = await Promise.all([
    app.request("/api/product/setup", "POST", { operationId: "one" }),
    app.request(
      "/api/product/setup",
      "POST",
      { operationId: "two" },
      "test-other"
    ),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).toSorted(),
    [200, 403]
  );
  const verifiedResult1 = await app.request(
    "/api/product/agents",
    "GET",
    undefined,
    null
  );
  assert.equal(verifiedResult1.status, 401);
  await app.options.withDatabase((db) => {
    assert.throws(
      () =>
        createFixtureSessionService(db, { ...app.options, mode: "production" }),
      /disabled in production/u
    );
  });
});

test("agent versions, message replay, SSE reconnect, citations, approval, and revocation use REST with PostgreSQL", async () => {
  const app = await createTestProduct();
  const setup = await app.install();
  const principalId = string(setup.principalId);
  assert.equal(setup.owner, true);
  const created = await app.createAgent();
  const agentId = string(created.agentId);
  assert.equal(created.version, 1);
  const verifiedResult2 = await app.request(
    "/api/product/agents",
    "POST",
    app.agentBody
  );
  assert.deepEqual(object(await verifiedResult2.json()), created);
  const updates = await Promise.all([
    app.request(`/api/product/agents/${agentId}`, "PUT", {
      ...app.agentBody,
      expectedVersion: 1,
      instructions: "Version two A.",
      operationId: "update-one",
    }),
    app.request(`/api/product/agents/${agentId}`, "PUT", {
      ...app.agentBody,
      expectedVersion: 1,
      instructions: "Version two B.",
      operationId: "update-two",
    }),
  ]);
  assert.deepEqual(
    updates.map((response) => response.status).toSorted(),
    [200, 409]
  );
  await app.options.withDatabase(async (db) => {
    const old = await createAgentRepository(db).get(
      id.organization(app.options.organizationId),
      id.agent(agentId),
      1,
      { deadlineAt: Date.now() + 5000 }
    );
    assert.equal(old.status, "ok");
    if (old.status === "ok") {
      assert.equal(old.value.instructions, "Use the pilot source.");
    }
  });
  const verifiedResult3 = await app.request("/api/product/agents", "POST", {
    ...app.agentBody,
    instructions: "Changed",
  });
  assert.equal(verifiedResult3.status, 409);
  const verifiedResult4 = await app.request(
    "/api/product/conversations",
    "POST",
    {
      agentId,
      operationId: "conversation-one",
    }
  );
  const conversation = object(await verifiedResult4.json());
  const conversationId = string(conversation.conversationId);
  const messagePath = `/api/product/conversations/${conversationId}/messages`;
  const replies = await Promise.all([
    app.request(messagePath, "POST", {
      eventId: "message-one",
      text: "Describe durable admission.",
    }),
    app.request(messagePath, "POST", {
      eventId: "message-one",
      text: "Describe durable admission.",
    }),
  ]);
  assert.deepEqual(
    replies.map((response) => response.status),
    [200, 200]
  );
  await app.options.withDatabase(async (db) => {
    const verifiedResult5 = await db.select().from(channelInbox);
    assert.equal(verifiedResult5.length, 1);
    const verifiedResult6 = await db.select().from(channelFixtureRun);
    assert.equal(verifiedResult6.length, 1);
    const verifiedResult7 = await db.select().from(channelItem);
    assert.equal(verifiedResult7.length, 6);
  });
  const verifiedResult8 = await app.request(messagePath, "POST", {
    eventId: "message-one",
    text: "Changed message",
  });
  assert.equal(verifiedResult8.status, 409);
  const verifiedResult9 = await app.request(
    `/api/product/conversations/${conversationId}`
  );
  const view = object(await verifiedResult9.json());
  const items = array(view.items).map(object);
  assert.deepEqual(
    items.map((item) => item.type),
    ["user", "tool", "tool", "output", "citation", "run"]
  );
  assert.equal(object(view.snapshot).address !== undefined, true);
  const cursor = string(items[1]?.cursor);
  const stream = await app.request(
    `/api/product/conversations/${conversationId}/events`,
    "GET",
    undefined,
    "test-owner",
    { "Last-Event-ID": cursor }
  );
  assert.equal(stream.headers.get("Content-Type"), "text/event-stream");
  const streamed = await stream.text();
  assert.equal(streamed.includes(`id: ${cursor}\n`), false);
  assert.equal(streamed.includes('"type":"citation"'), true);
  const citation = items.find((item) => item.type === "citation");
  const verifiedResult10 = await app.request(string(citation?.href));
  assert.equal(verifiedResult10.status, 200);
  const verifiedResult11 = await app.request(messagePath, "POST", {
    eventId: "approval-one",
    text: "Request approval before continuing.",
  });
  const approvalReply = object(await verifiedResult11.json());
  const runId = string(object(approvalReply.receipt).runId);
  const approve = await app.request(
    `/api/product/conversations/${conversationId}/approvals/${encodeURIComponent(`approval:${runId}`)}`,
    "POST",
    { operationId: "approve-one" }
  );
  assert.equal(approve.status, 200);
  assert.equal(object(object(await approve.json()).run).state, "completed");
  const verifiedResult12 = await app.request(
    `/api/product/conversations/${conversationId}/audit/${runId}`
  );
  assert.equal(verifiedResult12.status, 200);
  await app.options.withDatabase((db) =>
    createIdentityRepository(db).setManualGrant(
      app.options.organizationId,
      principalId,
      { action: "execute", resourceId: agentId, resourceKind: "agent" },
      false
    )
  );
  const verifiedResult13 = await app.request(messagePath, "POST", {
    eventId: "denied",
    text: "Denied",
  });
  assert.equal(verifiedResult13.status, 403);
  const verifiedResult14 = await app.request(
    "/api/product/agents",
    "POST",
    app.agentBody
  );
  assert.equal(verifiedResult14.status, 200);
  const verifiedResult15 = await app.request(messagePath, "POST", {
    eventId: "still-denied",
    text: "Denied after create replay",
  });
  assert.equal(verifiedResult15.status, 403);
  await app.options.withDatabase((db) =>
    createIdentityRepository(db).setManualGrant(
      app.options.organizationId,
      principalId,
      { action: "read", resourceId: agentId, resourceKind: "agent" },
      false
    )
  );
  const verifiedResult16 = await app.request(
    `/api/product/conversations/${conversationId}`
  );
  assert.equal(verifiedResult16.status, 403);
  const verifiedResult17 = await app.request(string(citation?.href));
  assert.equal(verifiedResult17.status, 403);
});

test("revoked subscriptions become idle so later healthy subscriptions progress", async () => {
  const app = await createTestProduct();
  const verifiedResult18 = await app.install();
  const ownerPrincipalId = string(verifiedResult18.principalId);
  const verifiedResult19 = await app.createAgent();
  const agentId = string(verifiedResult19.agentId);
  const target = await app.options.withDatabase((db) =>
    createIdentityRepository(db).provisionHumanPrincipal(
      app.options.organizationId,
      "test-other"
    )
  );
  await app.options.withDatabase(async (db) => {
    const identity = createIdentityRepository(db);
    await identity.setManualGrant(
      app.options.organizationId,
      target.id,
      { action: "read", resourceId: agentId, resourceKind: "agent" },
      true
    );
    await identity.setManualGrant(
      app.options.organizationId,
      ownerPrincipalId,
      { action: "read", resourceId: agentId, resourceKind: "agent" },
      false
    );
    await db.insert(channelConversation).values(
      Array.from({ length: 25 }, (_, index) => ({
        agentId,
        bindingKey: `denied-binding-${index}`,
        conversationId: `denied-${index}`,
        kind: "web" as const,
        lastProjectedAt: new Date(0),
        organizationId: app.options.organizationId,
        ownerPrincipalId,
        projectionState: "active" as const,
        sessionId: `denied-session-${index}`,
      }))
    );
    await db.insert(channelConversation).values({
      agentId,
      bindingKey: "healthy-binding",
      conversationId: "healthy",
      kind: "web",
      lastProjectedAt: new Date(1),
      organizationId: app.options.organizationId,
      ownerPrincipalId: target.id,
      projectionState: "active",
      sessionId: "healthy-session",
    });
  });
  const options = {
    ...app.options,
    sessions: (db: Parameters<typeof createFixtureSessionService>[0]) => ({
      ...createFixtureSessionService(db, app.options),
      inspect: (
        address: Parameters<
          ReturnType<typeof createFixtureSessionService>["inspect"]
        >[0]
      ) => ({
        status: "ok" as const,
        value: {
          address,
          agentVersion: 1,
          cursor: "1",
          runs: [
            {
              completedAt: Date.now(),
              runId: id.run("healthy-run"),
              state: "completed" as const,
            },
          ],
        },
      }),
      async *stream() {
        yield {
          status: "ok" as const,
          value: {
            cursor: "1",
            run: {
              completedAt: Date.now(),
              runId: id.run("healthy-run"),
              state: "completed" as const,
            },
            type: "run" as const,
          },
        };
      },
    }),
  };
  await drainChannelWork(options);
  await drainChannelWork(options);
  await app.options.withDatabase(async (db) => {
    const rows = await db.select().from(channelConversation);
    assert.equal(
      rows.every((row) => row.projectionState === "idle"),
      true
    );
    const items = await db.select().from(channelItem);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.conversationId, "healthy");
  });
});

test("stale access operation replay cannot restore a later revoked grant", async () => {
  const app = await createTestProduct();
  const setup = await app.install();
  const principalId = string(setup.principalId);
  const created = await app.createAgent();
  const agentId = string(created.agentId);
  const createdConversation = await app.request(
    "/api/product/conversations",
    "POST",
    { agentId, operationId: "access-conversation" }
  );
  const conversation = object(await createdConversation.json());
  const conversationId = string(conversation.conversationId);
  const path = `/api/product/agents/${agentId}/access/${principalId}`;
  const grant = {
    actions: ["read", "execute", "approve"],
    operationId: "enable-access",
  };
  const verifiedResult101 = await app.request(path, "PUT", grant);
  assert.equal(verifiedResult101.status, 200);
  const verifiedResult102 = await app.request(path, "PUT", {
    actions: [],
    operationId: "remove-access",
  });
  assert.equal(verifiedResult102.status, 200);
  const verifiedResult103 = await app.request(path, "PUT", grant);
  assert.equal(verifiedResult103.status, 200);
  const verifiedResult104 = await app.request(path, "PUT", {
    ...grant,
    actions: ["read"],
  });
  assert.equal(verifiedResult104.status, 409);
  const verifiedResult105 = await app.request(
    `/api/product/conversations/${conversationId}/messages`,
    "POST",
    { eventId: "denied-after-replay", text: "This must stay denied." }
  );
  assert.equal(verifiedResult105.status, 403);
});

test("one unavailable pending submission does not stop another admitted session", async () => {
  const app = await createTestProduct();
  await app.install();
  const verifiedResult106 = await app.createAgent();
  const agentId = string(verifiedResult106.agentId);
  const conversationResponse = await app.request(
    "/api/product/conversations",
    "POST",
    { agentId, operationId: "retry-conversation" }
  );
  const conversationId = string(
    object(await conversationResponse.json()).conversationId
  );
  const responses = await Promise.all(
    ["Unavailable request", "Healthy request"].map((text) =>
      app.request(
        `/api/product/conversations/${conversationId}/messages`,
        "POST",
        { eventId: text, text }
      )
    )
  );
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200]
  );
  await app.options.withDatabase((db) =>
    db.update(channelInbox).set({ receipt: null, state: "pending" })
  );
  const options = {
    ...app.options,
    sessions: (db: Parameters<typeof createFixtureSessionService>[0]) => {
      const fixture = createFixtureSessionService(db, app.options);
      return {
        ...fixture,
        submit: (
          command: Parameters<typeof fixture.submit>[0],
          effect: Parameters<typeof fixture.submit>[1]
        ) =>
          command.event.event.type === "user.message" &&
          command.event.event.payload.text === "Unavailable request"
            ? Promise.resolve({
                code: "provider-unavailable" as const,
                reason: "This session adapter is unavailable.",
                status: "unavailable" as const,
              })
            : fixture.submit(command, effect),
      };
    },
  };
  const result = await drainChannelWork(options);
  assert.equal(result.submitted, 1);
  await app.options.withDatabase(async (db) => {
    const inbox = await db.select().from(channelInbox);
    assert.deepEqual(inbox.map((row) => row.state).toSorted(), [
      "accepted",
      "pending",
    ]);
  });
});

test("audit reads require current company audit permission as well as conversation access", async () => {
  const app = await createTestProduct();
  const setup = await app.install();
  const ownerPrincipalId = string(setup.principalId);
  const created = await app.createAgent();
  const agentId = string(created.agentId);
  const other = await app.options.withDatabase((db) =>
    createIdentityRepository(db).provisionHumanPrincipal(
      app.options.organizationId,
      "test-other"
    )
  );
  await app.options.withDatabase(async (db) => {
    const identity = createIdentityRepository(db);
    await identity.setManualGrant(
      app.options.organizationId,
      other.id,
      { action: "read", resourceId: agentId, resourceKind: "agent" },
      true
    );
    await identity.setManualGrant(
      app.options.organizationId,
      other.id,
      { action: "execute", resourceId: agentId, resourceKind: "agent" },
      true
    );
  });
  const checkAuditUser = async (userId: string) => {
    const conversationResponse = await app.request(
      "/api/product/conversations",
      "POST",
      { agentId, operationId: `audit-conversation-${userId}` },
      userId
    );
    const conversationId = string(
      object(await conversationResponse.json()).conversationId
    );
    const message = await app.request(
      `/api/product/conversations/${conversationId}/messages`,
      "POST",
      { eventId: `audit-message-${userId}`, text: "Read the local source." },
      userId
    );
    assert.equal(message.status, 200);
    const messageResult = object(await message.json());
    const runId = string(object(messageResult.receipt).runId);
    const path = `/api/product/conversations/${conversationId}/audit/${runId}`;
    const response = await app.request(path, "GET", undefined, userId);
    assert.equal(response.status, userId === "test-owner" ? 200 : 403);
    if (userId === "test-owner") {
      await app.options.withDatabase(async (db) => {
        await db
          .delete(identityGrant)
          .where(
            and(
              eq(identityGrant.organizationId, app.options.organizationId),
              eq(identityGrant.principalId, ownerPrincipalId),
              eq(identityGrant.resourceKind, "audit"),
              eq(identityGrant.resourceId, app.options.organizationId),
              eq(identityGrant.action, "read")
            )
          );
      });
      const revoked = await app.request(path);
      assert.equal(revoked.status, 403);
    }
  };
  await checkAuditUser("test-owner");
  await checkAuditUser("test-other");
});
