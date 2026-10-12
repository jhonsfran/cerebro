/* oxlint-disable unicorn/no-await-expression-member -- Assertions inspect the preceding native response. */
import { test } from "bun:test";
import assert from "node:assert/strict";

import { createApiHandler } from "../../packages/api/src/handler";
import { createChannelService } from "../../packages/channels/src/service";
import { Unavailable } from "../../packages/contracts/src/failures";
import { id } from "../../packages/contracts/src/index";
import { eq } from "../../packages/db/node_modules/drizzle-orm";
import { createAgentRepository } from "../../packages/db/src/repositories/agents";
import { createIdentityRepository } from "../../packages/db/src/repositories/identity";
import { channelConversation } from "../../packages/db/src/schema/agents";
import {
  createFixtureChatClient,
  fixtureSubmissionCount,
} from "./fixture-session";
import {
  array,
  createTestProduct,
  object,
  string,
  TEST_BOOTSTRAP_TOKEN,
} from "./helpers";

test("setup with the bootstrap token chooses one owner", async () => {
  const app = await createTestProduct();
  const untrusted = await app.request("/api/product/setup", "POST", {
    operationId: "untrusted",
  });
  assert.equal(untrusted.status, 403);
  const responses = await Promise.all([
    app.request("/api/product/setup", "POST", {
      bootstrapToken: TEST_BOOTSTRAP_TOKEN,
      operationId: "one",
    }),
    app.request(
      "/api/product/setup",
      "POST",
      { bootstrapToken: TEST_BOOTSTRAP_TOKEN, operationId: "two" },
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
});

test("agent versions preserve publish replay and reject concurrent stale updates", async () => {
  const app = await createTestProduct();
  const setup = await app.install();
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
    { operationId: "denied-after-replay", text: "This must stay denied." }
  );
  assert.equal(verifiedResult105.status, 403);
});

test("a denied message is never admitted and is admitted on retry after access returns", async () => {
  const app = await createTestProduct();
  const setup = await app.install();
  const principalId = string(setup.principalId);
  const created = await app.createAgent();
  const agentId = string(created.agentId);
  const response = await app.request("/api/product/conversations", "POST", {
    agentId,
    operationId: "denied-conversation",
  });
  const conversationId = string(object(await response.json()).conversationId);
  const path = `/api/product/conversations/${conversationId}/messages`;
  const grant = (allowed: boolean) =>
    app.options.withDatabase((db) =>
      createIdentityRepository(db).setManualGrant(
        app.options.organizationId,
        principalId,
        { action: "execute", resourceId: agentId, resourceKind: "agent" },
        allowed
      )
    );
  await grant(false);
  const denied = await app.request(path, "POST", {
    operationId: "denied",
    text: "Denied message",
  });
  assert.equal(denied.status, 403);
  assert.equal(fixtureSubmissionCount(), 0);
  await grant(true);
  const admitted = await app.request(path, "POST", {
    operationId: "denied",
    text: "Denied message",
  });
  assert.equal(admitted.status, 200);
  assert.equal(fixtureSubmissionCount(), 1);
});

test("native Send retry, snapshot reconnect, source access, approval and Stop use REST", async () => {
  const app = await createTestProduct();
  const setup = await app.install();
  const principalId = string(setup.principalId);
  const agent = await app.createAgent();
  const agentId = string(agent.agentId);
  const created = await app.request("/api/product/conversations", "POST", {
    agentId,
    operationId: "native-conversation",
  });
  const conversationId = string(object(await created.json()).conversationId);
  const route = `/api/product/conversations/${conversationId}`;
  const input = {
    operationId: "input-one",
    text: "Describe durable admission.",
  };
  const first = await app.request(`${route}/messages`, "POST", input);
  const retry = await app.request(`${route}/messages`, "POST", input);
  assert.equal(object(object(await first.json()).receipt).accepted, true);
  assert.equal(object(object(await retry.json()).receipt).accepted, false);
  assert.equal(fixtureSubmissionCount(), 1);
  const response = await app.request(route);
  const snapshot = object(object(await response.json()).snapshot);
  const messages = array(snapshot.messages).map(object);
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant"]
  );
  assert.equal(messages[0]?.text, input.text);
  assert.match(string(messages[1]?.text), /Local pilot source/u);
  const observation = await app.request(`${route}/observations`);
  assert.equal(observation.status, 200);
  assert.match(
    observation.headers.get("content-type") ?? "",
    /application\/x-ndjson/u
  );
  const frame = object(JSON.parse((await observation.text()).trim()));
  assert.deepEqual(frame.snapshot, snapshot);
  const reattached = await app.request(`${route}/observations`);
  assert.deepEqual(
    object(JSON.parse((await reattached.text()).trim())).snapshot,
    snapshot
  );
  const sourceRoute = `${route}/sources/pilot-source`;
  assert.equal((await app.request(sourceRoute)).status, 200);
  assert.equal(
    (
      await app.request(`${route}/messages`, "POST", {
        operationId: "approval-one",
        text: "Request approval.",
      })
    ).status,
    200
  );
  const approvalRoute = `${route}/approvals/${encodeURIComponent("approval:approval-one")}`;
  const allowed = await app.request(approvalRoute, "POST", {
    decision: "allow",
  });
  assert.equal(object(object(await allowed.json()).approval).state, "allowed");
  assert.equal(
    (await app.request(approvalRoute, "POST", { decision: "allow" })).status,
    200
  );
  assert.equal(
    (await app.request(approvalRoute, "POST", { decision: "deny" })).status,
    409
  );
  await app.request(`${route}/messages`, "POST", {
    operationId: "stop-one",
    text: "Request approval before Stop.",
  });
  const stopped = await app.request(`${route}/stop`, "POST", {});
  assert.deepEqual(await stopped.json(), { stopped: true });
  await app.options.withDatabase((db) =>
    createIdentityRepository(db).setManualGrant(
      app.options.organizationId,
      principalId,
      { action: "read", resourceId: agentId, resourceKind: "agent" },
      false
    )
  );
  assert.equal((await app.request(route)).status, 403);
  assert.equal((await app.request(sourceRoute)).status, 403);
});

test("unavailable native Send admits a client retry once", async () => {
  const app = await createTestProduct();
  await app.install();
  const agent = await app.createAgent();
  const created = await app.request("/api/product/conversations", "POST", {
    agentId: string(agent.agentId),
    operationId: "retry-conversation",
  });
  const conversationId = string(object(await created.json()).conversationId);
  let available = false;
  const handler = createApiHandler({
    ...app.options,
    sessions: (db) => {
      const fixture = createFixtureChatClient(db, app.options);
      return {
        ...fixture,
        send: (request) =>
          available
            ? fixture.send(request)
            : Promise.reject(
                new Unavailable({ reason: "The session is restarting." })
              ),
      };
    },
  });
  const send = () =>
    handler(
      new Request(
        `http://cerebro.test/api/product/conversations/${conversationId}/messages`,
        {
          body: JSON.stringify({ operationId: "retry", text: "Retry me" }),
          headers: {
            "Content-Type": "application/json",
            "x-test-user": "test-owner",
          },
          method: "POST",
        }
      )
    );
  assert.equal((await send()).status, 503);
  assert.equal(fixtureSubmissionCount(), 0);
  available = true;
  const first = object(object(await (await send()).json()).receipt);
  const second = object(object(await (await send()).json()).receipt);
  assert.equal(first.accepted, true);
  assert.deepEqual(second, { ...first, accepted: false });
  assert.equal(fixtureSubmissionCount(), 1);
});

for (const engine of ["legacy", "pi-v1"] as const) {
  test(`retired ${engine} conversations reject native work and history`, async () => {
    const app = await createTestProduct();
    await app.install();
    const agent = await app.createAgent();
    const created = await app.request("/api/product/conversations", "POST", {
      agentId: string(agent.agentId),
      operationId: `retired-${engine}`,
    });
    const conversationId = string(object(await created.json()).conversationId);
    await app.options.withDatabase((db) =>
      db
        .update(channelConversation)
        .set({ engine, retiredAt: new Date() })
        .where(eq(channelConversation.conversationId, conversationId))
    );
    const route = `/api/product/conversations/${conversationId}`;
    assert.equal((await app.request(route)).status, 409);
    assert.equal(
      (
        await app.request(`${route}/messages`, "POST", {
          operationId: "retired-input",
          text: "Cannot run",
        })
      ).status,
      409
    );
    assert.equal((await app.request(`${route}/stop`, "POST", {})).status, 409);
    assert.equal(fixtureSubmissionCount(), 0);
  });
}

test("native approval denial retains its binding and decision", async () => {
  const app = await createTestProduct();
  await app.install();
  const agent = await app.createAgent();
  const created = await app.request("/api/product/conversations", "POST", {
    agentId: string(agent.agentId),
    operationId: "deny-conversation",
  });
  const conversationId = string(object(await created.json()).conversationId);
  await app.options.withDatabase(async (db) => {
    const service = createChannelService(db, app.options);
    await service.submit(
      "test-owner",
      conversationId,
      "approval-input",
      "Request approval."
    );
    const denied = await service.approve(
      "test-owner",
      conversationId,
      "approval:approval-input",
      "deny"
    );
    assert.equal(denied.approval.state, "denied");
    assert.deepEqual(denied.approval, {
      approvalId: "approval:approval-input",
      state: "denied",
    });
    assert.deepEqual(
      await service.approve(
        "test-owner",
        conversationId,
        "approval:approval-input",
        "deny"
      ),
      denied
    );
    await assert.rejects(
      service.approve(
        "test-owner",
        conversationId,
        "approval:approval-input",
        "allow"
      ),
      { status: 409 }
    );
    const { snapshot } = await service.readConversation(
      "test-owner",
      conversationId
    );
    assert.equal(snapshot.busy, false);
    assert.deepEqual(
      snapshot.messages.map((message) => message.text),
      ["Request approval."]
    );
  });
});

test("native messages require an operation ID; approvals and Stop reject extra fields", async () => {
  const app = await createTestProduct();
  await app.install();
  const agent = await app.createAgent();
  const created = await app.request("/api/product/conversations", "POST", {
    agentId: string(agent.agentId),
    operationId: "strict-inputs",
  });
  const route = `/api/product/conversations/${string(object(await created.json()).conversationId)}`;
  assert.equal(
    (
      await app.request(`${route}/messages`, "POST", {
        text: "Request approval.",
      })
    ).status,
    422
  );
  await app.request(`${route}/messages`, "POST", {
    operationId: "input",
    text: "Request approval.",
  });
  assert.equal(
    (
      await app.request(
        `${route}/approvals/${encodeURIComponent("approval:input")}`,
        "POST",
        { arguments: {}, decision: "allow" }
      )
    ).status,
    422
  );
  assert.equal(
    (await app.request(`${route}/stop`, "POST", { text: "Changed" })).status,
    422
  );
});

test("only product and Slack request bodies have the 100 KB limit", async () => {
  const app = await createTestProduct();
  const large = "x".repeat(150_000);
  const product = await app.request("/api/product/agents", "POST", {
    instructions: large,
  });
  assert.equal(product.status, 413);
  const rpc = await app.handler(
    new Request("http://cerebro.test/rpc/identity/currentPrincipal", {
      body: JSON.stringify({ json: { organizationId: large } }),
      headers: {
        "Content-Type": "application/json",
        "x-test-user": "test-owner",
      },
      method: "POST",
    })
  );
  assert.notEqual(rpc.status, 413);
});
