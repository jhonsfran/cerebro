import { test } from "bun:test";
import assert from "node:assert/strict";

import { openPrimaryConversation } from "../../packages/channels/src/primary-conversations";
import { digest } from "../../packages/channels/src/security";
import { createIdentityRepository } from "../../packages/db/src/repositories/identity";
import {
  channelConversation,
  channelConversationOperation,
} from "../../packages/db/src/schema/agents";
import { createTestProduct, object, string } from "./helpers";

const prepare = async () => {
  const app = await createTestProduct();
  const setup = await app.install();
  const agent = await app.createAgent();
  const agentId = string(agent.agentId);
  const open = (
    operationId: string,
    selectedAgent = agentId,
    userId = "test-owner"
  ) =>
    app.request(
      "/api/product/conversations",
      "POST",
      { agentId: selectedAgent, operationId },
      userId
    );
  const read = async (conversationId: string) => {
    const response = await app.request(
      `/api/product/conversations/${conversationId}`
    );
    assert.equal(response.status, 200);
    return object(object(await response.json()).snapshot);
  };
  return {
    ...app,
    agentId,
    open,
    principalId: string(setup.principalId),
    read,
  };
};

test("different open operations converge on one primary and retain its transcript and version after publication", async () => {
  const app = await prepare();
  const responses = await Promise.all(
    ["tab-one", "tab-two", "tab-three"].map((operationId) =>
      app.open(operationId)
    )
  );
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200, 200]
  );
  const opened = await Promise.all(
    responses.map(async (response) => object(await response.json()))
  );
  assert.deepEqual(opened, [opened[0], opened[0], opened[0]]);
  const conversationId = string(opened[0]?.conversationId);
  const route = `/api/product/conversations/${conversationId}`;
  const sent = await app.request(`${route}/messages`, "POST", {
    operationId: "retained-input",
    text: "Keep this context.",
  });
  assert.equal(sent.status, 200);
  const before = await app.read(conversationId);
  assert.equal(before.agentVersion, 1);
  const published = await app.request(
    `/api/product/agents/${app.agentId}`,
    "PUT",
    {
      ...app.agentBody,
      expectedVersion: 1,
      instructions: "New agent instructions.",
      operationId: "publish-second-version",
    }
  );
  assert.equal(published.status, 200);
  assert.equal(object(await published.json()).version, 2);
  const reopened = await app.open("after-publication");
  assert.equal(reopened.status, 200);
  assert.deepEqual(object(await reopened.json()), opened[0]);
  const replay = await app.open("tab-one");
  assert.equal(replay.status, 200);
  assert.deepEqual(object(await replay.json()), opened[0]);
  assert.deepEqual(await app.read(conversationId), before);
  const rows = await app.options.withDatabase(async (db) => ({
    conversations: await db.select().from(channelConversation),
    operations: await db.select().from(channelConversationOperation),
  }));
  assert.equal(rows.conversations.length, 1);
  assert.equal(rows.operations.length, 4);
  assert.equal(
    rows.conversations[0]?.bindingKey,
    `primary:${await digest({ agentId: app.agentId, organizationId: app.options.organizationId, ownerPrincipalId: app.principalId })}`
  );
});

test("concurrent operation reuse for another agent commits one primary and no orphan conversation", async () => {
  const app = await prepare();
  const other = await app.request("/api/product/agents", "POST", {
    ...app.agentBody,
    name: "Other agent",
    operationId: "other-agent",
  });
  assert.equal(other.status, 200);
  const otherAgentId = string(object(await other.json()).agentId);
  const outcomes = await Promise.all([
    app.open("shared-operation"),
    app.open("shared-operation", otherAgentId),
  ]);
  assert.deepEqual(
    outcomes.map((response) => response.status).toSorted(),
    [200, 409]
  );
  const winner = outcomes.find((response) => response.status === 200);
  assert.ok(winner);
  const result = object(await winner.json());
  const rows = await app.options.withDatabase(async (db) => ({
    conversations: await db.select().from(channelConversation),
    operations: await db.select().from(channelConversationOperation),
  }));
  assert.equal(rows.conversations.length, 1);
  assert.equal(rows.operations.length, 1);
  assert.equal(rows.conversations[0]?.conversationId, result.conversationId);
  assert.equal(rows.operations[0]?.conversationId, result.conversationId);
  const retry = await app.open("shared-operation", string(result.agentId));
  assert.equal(retry.status, 200);
  assert.deepEqual(object(await retry.json()), result);
});

test("primary identity and operation receipts isolate organizations and people", async () => {
  const app = await prepare();
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
  const ownerResponse = await app.open("same-operation");
  const otherResponse = await app.open(
    "same-operation",
    app.agentId,
    "test-other"
  );
  assert.equal(ownerResponse.status, 200);
  assert.equal(otherResponse.status, 200);
  const owner = object(await ownerResponse.json());
  const other = object(await otherResponse.json());
  assert.notEqual(owner.conversationId, other.conversationId);
  assert.notEqual(owner.sessionId, other.sessionId);
  const forbidden = await app.request(
    `/api/product/conversations/${string(owner.conversationId)}`,
    "GET",
    undefined,
    "test-other"
  );
  assert.equal(forbidden.status, 404);
  const organization = await app.options.withDatabase((db) =>
    openPrimaryConversation(db, {
      agentId: app.agentId,
      operationId: "same-operation",
      organizationId: "another-organization",
      ownerPrincipalId: app.principalId,
    })
  );
  assert.notEqual(organization.conversationId, owner.conversationId);
  assert.notEqual(organization.sessionId, owner.sessionId);
  const rows = await app.options.withDatabase(async (db) => ({
    operations: await db.select().from(channelConversationOperation),
    conversations: await db.select().from(channelConversation),
  }));
  assert.equal(rows.conversations.length, 3);
  assert.equal(
    new Set(rows.conversations.map((row) => row.bindingKey)).size,
    3
  );
  assert.equal(rows.operations.length, 3);
});
