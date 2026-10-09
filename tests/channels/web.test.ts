import { test } from "bun:test";
import assert from "node:assert/strict";

import { Effect } from "effect";

import { createProductHandler } from "../../packages/api/src/routers/conversations";
import { drainChannelWork } from "../../packages/channels/src/drain";
import { createFixtureSessionService } from "../../packages/channels/src/fixture-session";
import { runEffect } from "../../packages/channels/src/security";
import { createChannelService } from "../../packages/channels/src/service";
import {
  Denied,
  Unavailable,
  UnknownOutcome,
} from "../../packages/contracts/src/failures";
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
import {
  array,
  createTestProduct,
  domainSnapshot,
  object,
  string,
} from "./helpers";

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
    assert.equal(verifiedResult7.length, 5);
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
    ["user", "tool", "output", "citation", "run"]
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
    { decision: "allow", operationId: "approve-one", runId }
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
        engine: "pi-v1" as const,
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
      engine: "pi-v1",
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
      ) =>
        Effect.succeed(
          domainSnapshot(address, {
            revision: 1,
            runs: [
              {
                completedAt: Date.now(),
                runId: id.run("healthy-run"),
                state: "completed",
              },
            ],
          })
        ),
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
            ? Effect.fail(
                new Unavailable({
                  reason: "This session adapter is unavailable.",
                })
              )
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

test("a submission rejected while an effect is uncertain leaves nothing for the drain to retry", async () => {
  const app = await createTestProduct();
  await app.install();
  const created = await app.createAgent();
  const agentId = string(created.agentId);
  const response = await app.request("/api/product/conversations", "POST", {
    agentId,
    operationId: "uncertain-conversation",
  });
  const conversationId = string(object(await response.json()).conversationId);
  let uncertain = true;
  const submissions: string[] = [];
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
          Effect.gen(function* submit() {
            if (uncertain) {
              return yield* Effect.fail(
                new UnknownOutcome({
                  operationId: id.operation("uncertain-write"),
                  reason:
                    "Reconcile the uncertain effect before admitting another input",
                })
              );
            }
            submissions.push(
              command.event.event.type === "user.message"
                ? command.event.event.payload.text
                : ""
            );
            return yield* fixture.submit(command, effect);
          }),
      };
    },
  };
  const handler = createProductHandler(options);
  const submit = (eventId: string, text: string) =>
    handler(
      new Request(
        `http://cerebro.test/api/product/conversations/${conversationId}/messages`,
        {
          body: JSON.stringify({ eventId, text }),
          headers: {
            "Content-Type": "application/json",
            "x-test-user": "test-owner",
          },
          method: "POST",
        }
      )
    );
  const rejected = await submit("follow-up", "Follow-up while uncertain");
  assert.equal(rejected.status, 409);
  const rows = await app.options.withDatabase((db) =>
    db
      .select()
      .from(channelInbox)
      .where(eq(channelInbox.conversationId, conversationId))
  );
  assert.deepEqual(rows, []);
  uncertain = false;
  const drained = await drainChannelWork(options);
  assert.equal(drained.submitted, 0);
  assert.deepEqual(submissions, []);
  const retried = await submit("follow-up", "Follow-up while uncertain");
  assert.equal(retried.status, 200);
  assert.deepEqual(submissions, ["Follow-up while uncertain"]);
});

test("a stale drain selection cannot submit a denied event after access returns", async () => {
  const app = await createTestProduct();
  await app.install();
  const created = await app.createAgent();
  const agentId = string(created.agentId);
  const response = await app.request("/api/product/conversations", "POST", {
    agentId,
    operationId: "stale-drain-conversation",
  });
  const conversationId = string(object(await response.json()).conversationId);
  const selected = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let available = false;
  let denied = false;
  const submissions: string[] = [];
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
          Effect.gen(function* submit() {
            if (!available) {
              return yield* Effect.fail(
                new Unavailable({ reason: "Seed pending admission." })
              );
            }
            const text =
              command.event.event.type === "user.message"
                ? command.event.event.payload.text
                : "";
            if (text === "First pending event") {
              selected.resolve();
              yield* Effect.promise(() => release.promise);
            }
            if (denied && text === "Denied pending event") {
              return yield* Effect.fail(
                new Denied({
                  code: "unauthorized",
                  reason: "Source access changed.",
                })
              );
            }
            submissions.push(text);
            return yield* fixture.submit(command, effect);
          }),
      };
    },
  };
  const handler = createProductHandler(options);
  const submit = (eventId: string, text: string) =>
    handler(
      new Request(
        `http://cerebro.test/api/product/conversations/${conversationId}/messages`,
        {
          body: JSON.stringify({ eventId, text }),
          headers: {
            "Content-Type": "application/json",
            "x-test-user": "test-owner",
          },
          method: "POST",
        }
      )
    );
  const first = await submit("first", "First pending event");
  assert.equal(first.status, 503);
  const second = await submit("second", "Denied pending event");
  assert.equal(second.status, 503);
  await app.options.withDatabase(async (db) => {
    const rows = await db.select().from(channelInbox);
    const firstEntry = rows.find(
      (entry) =>
        entry.envelope.event.type === "user.message" &&
        entry.envelope.event.payload.text === "First pending event"
    );
    assert.ok(firstEntry);
    await db
      .update(channelInbox)
      .set({ lastAttemptAt: new Date(1) })
      .where(eq(channelInbox.eventKey, firstEntry.eventKey));
  });
  available = true;
  const draining = drainChannelWork(options);
  try {
    await selected.promise;
    denied = true;
    const rejection = await submit("second", "Denied pending event");
    assert.equal(rejection.status, 403);
    const before = await app.options.withDatabase((db) =>
      db.select().from(channelInbox)
    );
    assert.equal(
      before.find(
        (entry) =>
          entry.envelope.event.type === "user.message" &&
          entry.envelope.event.payload.text === "Denied pending event"
      )?.state,
      "denied"
    );
    denied = false;
  } finally {
    release.resolve();
  }
  const drained = await draining;
  assert.equal(drained.submitted, 1);
  assert.deepEqual(submissions, ["First pending event"]);
  const after = await app.options.withDatabase((db) =>
    db.select().from(channelInbox)
  );
  assert.equal(
    after.find(
      (entry) =>
        entry.envelope.event.type === "user.message" &&
        entry.envelope.event.payload.text === "Denied pending event"
    )?.state,
    "denied"
  );
  const replay = await submit("second", "Denied pending event");
  assert.equal(replay.status, 403);
  assert.deepEqual(submissions, ["First pending event"]);
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

for (const retirement of ["legacy", "retired"] as const) {
  test(`${retirement} conversations return authorized PostgreSQL transcript and all runs without opening Pi`, async () => {
    const app = await createTestProduct();
    await app.install();
    const agent = await app.createAgent();
    const response = await app.request("/api/product/conversations", "POST", {
      agentId: string(agent.agentId),
      operationId: `retirement-${retirement}`,
    });
    const created = object(await response.json());
    const conversationId = string(created.conversationId);
    let opens = 0;
    await app.options.withDatabase(async (db) => {
      await db
        .update(channelConversation)
        .set(
          retirement === "legacy"
            ? { engine: "legacy-v1" }
            : { retiredAt: new Date() }
        )
        .where(eq(channelConversation.conversationId, conversationId));
      await db.insert(channelItem).values([
        ...Array.from({ length: 200 }, (_, index) => ({
          conversationId,
          item: {
            eventId: `historical-${index}`,
            text: `Historical question ${index}`,
            type: "user" as const,
          },
          itemKey: `${conversationId}:user:${index}`,
          organizationId: app.options.organizationId,
        })),
        {
          conversationId,
          item: {
            dependencies: { sourceIds: [], toolIds: [] },
            runId: "historical-run",
            text: "Retained answer",
            type: "output" as const,
          },
          itemKey: `${conversationId}:answer`,
          organizationId: app.options.organizationId,
        },
        {
          conversationId,
          item: {
            run: {
              completedAt: 42,
              runId: id.run("historical-run"),
              state: "completed" as const,
            },
            runId: "historical-run",
            type: "run" as const,
          },
          itemKey: `${conversationId}:run`,
          organizationId: app.options.organizationId,
        },
      ]);
      const service = createChannelService(db, {
        ...app.options,
        sessions: () => {
          opens += 1;
          throw new Error("Retired history must not open Pi.");
        },
      });
      const first = await service.readConversation(
        "test-owner",
        conversationId
      );
      assert.equal(first.mode, "retired");
      assert.equal(first.items.length, 200);
      assert.equal(first.snapshot.runs.length, 1);
      const next = await service.readConversation(
        "test-owner",
        conversationId,
        first.cursor
      );
      assert.equal(next.items.length, 2);
      assert.equal(next.items[0]?.type, "output");
      const history = await service.history("test-owner", conversationId);
      assert.equal(history.runs[0]?.runId, "historical-run");
      await assert.rejects(service.chatAccess("test-owner", conversationId), {
        code: "retired",
        status: 409,
      });
      await assert.rejects(
        service.submit(
          "test-owner",
          conversationId,
          "new-event",
          "New input",
          "steer"
        ),
        { code: "retired", status: 409 }
      );
      await assert.rejects(
        service.approve(
          "test-owner",
          conversationId,
          "approval",
          "operation",
          "historical-run",
          "allow"
        ),
        { code: "retired", status: 409 }
      );
      await assert.rejects(
        service.cancel(
          "test-owner",
          conversationId,
          "historical-run",
          "operation"
        ),
        { code: "retired", status: 409 }
      );
      await assert.rejects(
        service.readConversation("test-other", conversationId),
        { status: 403 }
      );
      assert.equal(opens, 0);
    });
  });
}

test("submission mode is immutable in admission and survives delayed drain replay", async () => {
  const app = await createTestProduct();
  await app.install();
  const agent = await app.createAgent();
  const response = await app.request("/api/product/conversations", "POST", {
    agentId: string(agent.agentId),
    operationId: "mode-replay",
  });
  const conversationId = string(object(await response.json()).conversationId);
  const modes: unknown[] = [];
  await app.options.withDatabase(async (db) => {
    const fixture = createFixtureSessionService(db, app.options);
    const service = createChannelService(db, {
      ...app.options,
      sessions: () => ({
        ...fixture,
        submit: (command) => {
          modes.push(command.mode);
          return Effect.fail(new Unavailable({ reason: "Delayed admission." }));
        },
      }),
    });
    await assert.rejects(
      service.submit(
        "test-owner",
        conversationId,
        "mode-event",
        "Steer this work",
        "steer"
      ),
      { status: 503 }
    );
    await assert.rejects(
      service.submit(
        "test-owner",
        conversationId,
        "mode-event",
        "Steer this work",
        "follow-up"
      ),
      { status: 409 }
    );
    const [admission] = await db.select().from(channelInbox);
    assert.equal(admission.submissionMode, "steer");
    assert.equal(admission.state, "pending");
  });
  await drainChannelWork({
    ...app.options,
    sessions: (db) => {
      const fixture = createFixtureSessionService(db, app.options);
      return {
        ...fixture,
        submit: (command, effect) => {
          modes.push(command.mode);
          return fixture.submit(command, effect);
        },
      };
    },
  });
  assert.deepEqual(modes, ["steer", "steer"]);
  await app.options.withDatabase(async (db) => {
    const [admission] = await db.select().from(channelInbox);
    assert.equal(admission.state, "accepted");
    const records = await db
      .select()
      .from(channelItem)
      .where(eq(channelItem.conversationId, conversationId));
    const message = records.find((entry) => entry.item.type === "user")?.item;
    assert.equal(message?.type === "user" ? message.mode : undefined, "steer");
  });
});

test("fixture approval denial keeps its decision and operation identity in the domain snapshot", async () => {
  const app = await createTestProduct();
  await app.install();
  const agent = await app.createAgent();
  const createdResponse = await app.request(
    "/api/product/conversations",
    "POST",
    { agentId: string(agent.agentId), operationId: "deny-approval" }
  );
  const conversation = object(await createdResponse.json());
  const conversationId = string(conversation.conversationId);
  await app.options.withDatabase(async (db) => {
    const service = createChannelService(db, app.options);
    const { receipt } = await service.submit(
      "test-owner",
      conversationId,
      "approval-event",
      "Request approval",
      "follow-up"
    );
    const approvalId = `approval:${receipt.runId}`;
    const result = await service.approve(
      "test-owner",
      conversationId,
      approvalId,
      "deny-operation",
      receipt.runId,
      "deny"
    );
    assert.equal(result.run.state, "cancelled");
    assert.deepEqual(
      await service.approve(
        "test-owner",
        conversationId,
        approvalId,
        "deny-operation",
        receipt.runId,
        "deny"
      ),
      result
    );
    await assert.rejects(
      service.approve(
        "test-owner",
        conversationId,
        approvalId,
        "deny-operation",
        receipt.runId,
        "allow"
      ),
      { code: "digest-mismatch", status: 409 }
    );
    const { address, context } = await service.chatAccess(
      "test-owner",
      conversationId
    );
    const snapshot = await runEffect(
      createFixtureSessionService(db, app.options).inspect(address, context, {
        deadlineAt: Date.now() + 30_000,
      })
    );
    assert.equal(snapshot.approvals[0]?.state, "denied");
    assert.equal(snapshot.tools[0]?.state, "cancelled");
    assert.equal(snapshot.outputs.length, 0);
  });
});
