import { test } from "bun:test";
import assert from "node:assert/strict";

import { Schema } from "effect";

import { Unavailable } from "../../packages/contracts/src/failures";
import { ChatSnapshot } from "../../packages/contracts/src/session-service";
import type { ChatClient } from "../../packages/contracts/src/session-service";
import { eq } from "../../packages/db/node_modules/drizzle-orm";
import { createIdentityRepository } from "../../packages/db/src/repositories/identity";
import { channelConversation } from "../../packages/db/src/schema/agents";
import { createTestProduct, object, string } from "./helpers";

const prepare = async (sessions?: (client: ChatClient) => ChatClient) => {
  const app = await createTestProduct(undefined, undefined, sessions);
  const setup = await app.install();
  const agent = await app.createAgent();
  const agentId = string(agent.agentId);
  const response = await app.request("/api/product/conversations", "POST", {
    agentId,
    operationId: "fork-parent",
  });
  assert.equal(response.status, 200);
  const parent = object(await response.json());
  const parentId = string(parent.conversationId);
  const path = `/api/product/conversations/${parentId}`;
  const send = async (operationId: string, text: string) => {
    const result = await app.request(`${path}/messages`, "POST", {
      operationId,
      text,
    });
    assert.equal(result.status, 200);
  };
  const read = async (conversationId = parentId) => {
    const result = await app.request(
      `/api/product/conversations/${conversationId}`
    );
    assert.equal(result.status, 200);
    return Schema.decodeUnknownSync(ChatSnapshot)(
      object(await result.json()).snapshot
    );
  };
  const fork = (
    operationId = "fork-operation",
    entryId = "answer:first",
    userId = "test-owner"
  ) => app.request(`${path}/fork`, "POST", { entryId, operationId }, userId);
  return {
    ...app,
    agentId,
    fork,
    parentId,
    parentSessionId: string(parent.sessionId),
    path,
    principalId: string(setup.principalId),
    read,
    send,
  };
};

test("a fork reserves one immutable origin, inherits the selected prefix and pinned version, then continues independently", async () => {
  const app = await prepare();
  await app.send("first", "Before the branch.");
  await app.send("second", "Only in the source chat.");
  const updated = await app.request(
    `/api/product/agents/${app.agentId}`,
    "PUT",
    {
      ...app.agentBody,
      expectedVersion: 1,
      instructions: "New version instructions.",
      operationId: "publish-version-two",
    }
  );
  assert.equal(updated.status, 200);
  assert.equal(object(await updated.json()).version, 2);
  const branch = await app.fork();
  assert.equal(branch.status, 200);
  const created = object(await branch.json());
  const branchId = string(created.conversationId);
  const replay = await app.fork();
  assert.equal(replay.status, 200);
  assert.deepEqual(object(await replay.json()), created);
  const snapshot = await app.read(branchId);
  assert.equal(snapshot.agentVersion, 1);
  assert.deepEqual(snapshot.activity?.origin, {
    conversationId: app.parentId,
    entryId: "answer:first",
  });
  assert.deepEqual(
    snapshot.messages.map((message) => message.id),
    ["first", "answer:first"]
  );
  assert.deepEqual(snapshot.approvals, []);
  assert.deepEqual(snapshot.queuedInputs, []);
  const rows = await app.options.withDatabase((db) =>
    db.select().from(channelConversation)
  );
  const branches = rows.filter((row) => row.forkOrigin);
  assert.equal(branches.length, 1);
  assert.deepEqual(branches[0]?.forkOrigin, {
    agentVersion: 1,
    entryId: "answer:first",
    parentConversationId: app.parentId,
    parentSessionId: app.parentSessionId,
  });
  assert.equal(branches[0]?.ownerPrincipalId, app.principalId);
  const sent = await app.request(
    `/api/product/conversations/${branchId}/messages`,
    "POST",
    { operationId: "branch-only", text: "Continue this branch." }
  );
  assert.equal(sent.status, 200);
  const source = await app.read();
  const continued = await app.read(branchId);
  assert.deepEqual(
    source.messages.map((message) => message.id),
    ["first", "answer:first", "second", "answer:second"]
  );
  assert.deepEqual(
    continued.messages.map((message) => message.id),
    ["first", "answer:first", "branch-only", "answer:branch-only"]
  );
});

test("fork operation reuse with another entry is rejected and invalid entries reserve no chat", async () => {
  const app = await prepare();
  await app.send("first", "First input.");
  await app.send("second", "Second input.");
  const created = await app.fork();
  assert.equal(created.status, 200);
  const changed = await app.fork("fork-operation", "answer:second");
  assert.equal(changed.status, 409);
  const invalid = await app.fork("invalid-fork", "missing-entry");
  assert.equal(invalid.status, 422);
  const rows = await app.options.withDatabase((db) =>
    db.select().from(channelConversation)
  );
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => row.forkOrigin).length, 1);
});

test("a persisted fork replays after source compaction without validating the old entry again", async () => {
  let compacted = false;
  let parentId = "";
  const app = await prepare((client) => ({
    ...client,
    read: async (request) => {
      const snapshot = await client.read(request);
      return compacted && request.address.conversationId === parentId
        ? {
            ...snapshot,
            messages: [
              {
                id: "summary",
                role: "assistant",
                state: "complete",
                text: "Earlier context summary.",
              },
            ],
          }
        : snapshot;
    },
  }));
  ({ parentId } = app);
  await app.send("first", "Keep this branch.");
  const created = await app.fork();
  assert.equal(created.status, 200);
  const branch = object(await created.json());
  compacted = true;
  const source = await app.read();
  assert.deepEqual(
    source.messages.map((message) => message.id),
    ["summary"]
  );
  const replay = await app.fork();
  assert.equal(replay.status, 200);
  assert.deepEqual(object(await replay.json()), branch);
  const changed = await app.fork("fork-operation", "another-entry");
  assert.equal(changed.status, 409);
  await app.options.withDatabase((db) =>
    createIdentityRepository(db).provisionHumanPrincipal(
      app.options.organizationId,
      "test-other"
    )
  );
  const foreign = await app.fork(
    "fork-operation",
    "answer:first",
    "test-other"
  );
  assert.equal(foreign.status, 404);
  await app.options.withDatabase((db) =>
    db
      .update(channelConversation)
      .set({ retiredAt: new Date() })
      .where(eq(channelConversation.conversationId, app.parentId))
  );
  const retiredReplay = await app.fork();
  assert.equal(retiredReplay.status, 200);
  assert.deepEqual(object(await retiredReplay.json()), branch);
  const restored = await app.read(string(branch.conversationId));
  assert.deepEqual(
    restored.messages.map((message) => message.id),
    ["first", "answer:first"]
  );
});

test("an identity with agent access cannot fork or control another identity's chat", async () => {
  const app = await prepare();
  await app.send("first", "Owner input.");
  await app.options.withDatabase(async (db) => {
    const identity = createIdentityRepository(db);
    const other = await identity.provisionHumanPrincipal(
      app.options.organizationId,
      "test-other"
    );
    await Promise.all(
      (["read", "execute"] as const).map((action) =>
        identity.setManualGrant(
          app.options.organizationId,
          other.id,
          { action, resourceId: app.agentId, resourceKind: "agent" },
          true
        )
      )
    );
  });
  const owned = await app.request(
    "/api/product/conversations",
    "POST",
    { agentId: app.agentId, operationId: "other-chat" },
    "test-other"
  );
  assert.equal(owned.status, 200);
  const foreignFork = await app.fork(
    "foreign-fork",
    "answer:first",
    "test-other"
  );
  assert.equal(foreignFork.status, 404);
  const foreignControl = await app.request(
    `${app.path}/control`,
    "POST",
    { kind: "compact", operationId: "foreign-compact" },
    "test-other"
  );
  assert.equal(foreignControl.status, 404);
  const source = await app.read();
  assert.deepEqual(source.activity?.compactions, []);
  const rows = await app.options.withDatabase((db) =>
    db.select().from(channelConversation)
  );
  assert.equal(rows.filter((row) => row.forkOrigin).length, 0);
});

for (const failurePoint of ["before", "after"] as const) {
  test(`a fork recovers a lost ${failurePoint}-materialization response through the stored origin`, async () => {
    let fail = true;
    const app = await prepare((client) => ({
      ...client,
      fork: async (request) => {
        if (fail && failurePoint === "before") {
          fail = false;
          throw new Unavailable({ reason: "Injected lost fork request." });
        }
        const result = await client.fork(request);
        if (fail) {
          fail = false;
          throw new Unavailable({ reason: "Injected lost fork response." });
        }
        return result;
      },
    }));
    await app.send("first", "Recover this prefix.");
    const first = await app.fork();
    assert.equal(first.status, 503);
    const rows = await app.options.withDatabase((db) =>
      db.select().from(channelConversation)
    );
    const reserved = rows.find((row) => row.forkOrigin);
    assert.ok(reserved);
    const reopened = await app.read(reserved.conversationId);
    assert.equal(reopened.agentVersion, 1);
    assert.deepEqual(
      reopened.messages.map((message) => message.id),
      ["first", "answer:first"]
    );
    const retried = await app.fork();
    assert.equal(retried.status, 200);
    assert.equal(
      object(await retried.json()).conversationId,
      reserved.conversationId
    );
    const branches = await app.options.withDatabase((db) =>
      db
        .select()
        .from(channelConversation)
        .where(eq(channelConversation.conversationId, reserved.conversationId))
    );
    assert.equal(branches.length, 1);
  });
}

test("chat controls reach their scope with stable receipts and observable activity", async () => {
  const app = await prepare();
  const command = {
    instruction: "Review the queue.",
    kind: "schedule",
    operationId: "schedule-once",
    recurrence: { interval: 1, timezone: "America/Bogota", unit: "day" },
    runAt: Date.now() + 60_000,
  };
  const first = await app.request(`${app.path}/control`, "POST", command);
  assert.equal(first.status, 200);
  const receipt = object(await first.json());
  assert.deepEqual(receipt, { id: "schedule:schedule-once", kind: "schedule" });
  const duplicate = await app.request(`${app.path}/control`, "POST", command);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(object(await duplicate.json()), receipt);
  const compact = await app.request(`${app.path}/control`, "POST", {
    instructions: "Keep decisions.",
    kind: "compact",
    operationId: "compact-once",
  });
  assert.equal(compact.status, 200);
  const changed = await app.request(`${app.path}/control`, "POST", {
    ...command,
    instruction: "Another request.",
  });
  assert.equal(changed.status, 409);
  const active = await app.read();
  assert.deepEqual(active.activity?.reminders, [
    {
      id: "schedule:schedule-once",
      instruction: command.instruction,
      recurrence: command.recurrence,
      runAt: command.runAt,
      state: "scheduled",
    },
  ]);
  assert.deepEqual(active.activity?.compactions, [
    {
      attempt: 1,
      blocking: false,
      id: "compact:compact-once",
      reason: "manual",
    },
  ]);
  const cancelled = await app.request(`${app.path}/control`, "POST", {
    kind: "cancel-schedule",
    scheduleId: string(receipt.id),
  });
  assert.equal(cancelled.status, 200);
  const after = await app.read();
  assert.deepEqual(
    after.activity?.reminders.map((reminder) => reminder.state),
    ["cancelled"]
  );
});
