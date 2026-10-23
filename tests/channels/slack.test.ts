import { test } from "bun:test";
import assert from "node:assert/strict";

import { digest } from "../../packages/channels/src/security";
import {
  createSlackApi,
  toSlackText,
} from "../../packages/channels/src/slack-api";
import type {
  SlackApi,
  SlackResult,
} from "../../packages/channels/src/slack-api";
import {
  APPROVE_ACTION,
  deliverSlackReplies,
} from "../../packages/channels/src/slack-replies";
import type { SlackDelivery } from "../../packages/channels/src/slack-replies";
import { id } from "../../packages/contracts/src/index";
import { createIdentityRepository } from "../../packages/db/src/repositories/identity";
import {
  channelConversation,
  channelLinkEvent,
} from "../../packages/db/src/schema/agents";
import { fixtureSubmissionCount } from "./fixture-session";
import {
  createTestProduct,
  chatSnapshot,
  object,
  signSlack,
  signSlackRaw,
  string,
} from "./helpers";

const slackConfiguration = () => ({
  agentId: "unset",
  apiUrl: "http://slack.test/api",
  appId: "test-app",
  botToken: "test-bot-token",
  signingSecret: "test-signing-secret",
  workspaceId: "test-workspace",
});
const event = (
  eventId: string,
  text: string,
  threadTimestamp?: string,
  overrides: Record<string, unknown> = {}
) => ({
  api_app_id: "test-app",
  event: {
    channel: "D-test",
    channel_type: "im",
    text,
    ...(threadTimestamp ? { thread_ts: threadTimestamp } : {}),
    ts: eventId === "link" ? "1.0" : "2.0",
    type: "message",
    user: "slack-user",
    ...overrides,
  },
  event_id: eventId,
  team_id: "test-workspace",
  type: "event_callback",
});

// Records every Slack Web API call the product makes.
const slackRecorder = () => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(input).split("/").at(-1) ?? "";
    calls.push({ body: JSON.parse(String(init?.body)), method });
    return Promise.resolve(
      Response.json({ channel: "D-test", ok: true, ts: `${calls.length}.0` })
    );
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
};

const linkedProduct = async () => {
  const configuration = slackConfiguration();
  const slack = slackRecorder();
  const app = await createTestProduct(configuration, slack.fetch);
  const setup = await app.install();
  const principalId = string(setup.principalId);
  const agent = await app.createAgent();
  configuration.agentId = string(agent.agentId);
  const code = "a".repeat(64);
  await app.options.withDatabase(async (db) =>
    createIdentityRepository(db).createSlackLinkChallenge(
      app.options.organizationId,
      principalId,
      await digest(code),
      new Date(Date.now() + 60_000)
    )
  );
  const send = async (body: unknown, headers?: Record<string, string>) =>
    app.request(
      "/api/channels/slack/events",
      "POST",
      body,
      null,
      headers ?? (await signSlack(body, configuration.signingSecret))
    );
  return { app, code, configuration, principalId, send, slack };
};

test("Slack linking, event replay, and thread sessions persist in PostgreSQL", async () => {
  const { app, code, configuration, principalId, send, slack } =
    await linkedProduct();
  const linkEvent = event("link", `link ${code}`);
  const linkHeaders = await signSlack(linkEvent, configuration.signingSecret);
  const linked = await Promise.all([
    send(linkEvent, linkHeaders),
    send(linkEvent, linkHeaders),
  ]);
  assert.deepEqual(
    linked.map((response) => response.status),
    [200, 200]
  );
  await app.options.withDatabase(async (db) => {
    const receipts = await db.select().from(channelLinkEvent);
    assert.equal(receipts.length, 1);
    assert.equal(JSON.stringify(receipts).includes(code), false);
  });
  // Only the first delivery of the link event confirms it in Slack.
  assert.equal(
    slack.calls.filter((call) =>
      String(call.body.text).startsWith("Your Slack account is linked")
    ).length,
    1
  );
  assert.equal(fixtureSubmissionCount(), 0);
  const message = event("message-one", "Describe the pilot source.");
  const headers = await signSlack(message, configuration.signingSecret);
  const accepted = await Promise.all([
    send(message, headers),
    send(message, headers),
  ]);
  assert.deepEqual(
    accepted.map((response) => response.status),
    [200, 200]
  );
  assert.equal(fixtureSubmissionCount(), 1);
  const followup = event("message-two", "Continue in this thread.", "2.0");
  const continued = await send(followup);
  assert.equal(continued.status, 200);
  await app.options.withDatabase(async (db) => {
    const conversations = await db.select().from(channelConversation);
    assert.equal(conversations.length, 1);
  });
  const changed = await send(event("message-one", "Changed text"));
  assert.equal(changed.status, 200);
  assert.equal(object(object(await changed.json()).receipt).accepted, false);
  const forged = await send(message, {
    ...headers,
    "x-slack-signature": `v0=${"0".repeat(64)}`,
  });
  assert.equal(forged.status, 401);
  const stale = await send(
    message,
    await signSlack(message, configuration.signingSecret, "1")
  );
  assert.equal(stale.status, 401);
  await app.options.withDatabase((db) =>
    createIdentityRepository(db).setManualGrant(
      app.options.organizationId,
      principalId,
      {
        action: "execute",
        resourceId: configuration.agentId,
        resourceKind: "agent",
      },
      false
    )
  );
  const denied = await send(event("denied", "Denied message", "2.0"));
  assert.equal(denied.status, 403);
});

test("Slack answers unlinked people, bad link codes, and channel mentions with a hint", async () => {
  const { send, slack } = await linkedProduct();
  const unlinked = await send(event("unlinked", "Hello"));
  assert.equal(unlinked.status, 200);
  assert.deepEqual(object(await unlinked.json()), { linked: false });
  const badLink = await send(event("bad-link", `link ${"b".repeat(64)}`));
  assert.equal(badLink.status, 200);
  const mention = await send(
    event("mention", "<@bot> help", undefined, {
      channel: "C-test",
      channel_type: "channel",
      type: "app_mention",
    })
  );
  assert.equal(mention.status, 200);
  const shared = await send(
    event("shared", "Hello channel", undefined, {
      channel: "C-test",
      channel_type: "channel",
    })
  );
  assert.deepEqual(object(await shared.json()), { ignored: true });
  assert.deepEqual(
    slack.calls.map((call) => [call.method, String(call.body.text)]),
    [
      [
        "chat.postMessage",
        "Link your Slack account first: in Cerebro, choose *Link your Slack account* and send me the `link <code>` message it shows.",
      ],
      [
        "chat.postMessage",
        "That link code is invalid, expired, or already used. Create a new one in Cerebro.",
      ],
      [
        "chat.postEphemeral",
        "I answer in direct messages, so only you can see the answer. Open a DM with me to ask.",
      ],
    ]
  );
  // A retried event never repeats its hint.
  const retried = event("unlinked", "Hello");
  await send(retried, {
    ...(await signSlack(retried, slackConfiguration().signingSecret)),
    "x-slack-retry-num": "1",
  });
  assert.equal(slack.calls.length, 3);
});

test("Slack events are acknowledged before the work runs", async () => {
  const { app, code, configuration, principalId, send, slack } =
    await linkedProduct();
  await send(event("link", `link ${code}`));
  const pending: Promise<unknown>[] = [];
  const background = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
  };
  const message = event("background", "Answer later.");
  const raw = JSON.stringify(message);
  const response = await app.handler(
    new Request("http://cerebro.test/api/channels/slack/events", {
      body: raw,
      headers: {
        "Content-Type": "application/json",
        ...(await signSlackRaw(raw, configuration.signingSecret)),
      },
      method: "POST",
    }),
    background
  );
  assert.equal(response.status, 200);
  assert.deepEqual(object(await response.json()), { ok: true });
  await Promise.all(pending);
  assert.equal(fixtureSubmissionCount(), 1);
  // A failure after the acknowledgement is reported in the thread.
  await app.options.withDatabase((db) =>
    createIdentityRepository(db).setManualGrant(
      app.options.organizationId,
      principalId,
      {
        action: "execute",
        resourceId: configuration.agentId,
        resourceKind: "agent",
      },
      false
    )
  );
  const failing = event("failing", "This cannot start.");
  const failingRaw = JSON.stringify(failing);
  await app.handler(
    new Request("http://cerebro.test/api/channels/slack/events", {
      body: failingRaw,
      headers: {
        "Content-Type": "application/json",
        ...(await signSlackRaw(failingRaw, configuration.signingSecret)),
      },
      method: "POST",
    }),
    background
  );
  await Promise.all(pending);
  assert.equal(
    slack.calls.at(-1)?.body.text,
    "Sorry, I could not start on that. Please send it again."
  );
});

test("a Slack button decides an approval as the linked person", async () => {
  const { app, code, configuration, send } = await linkedProduct();
  await send(event("link", `link ${code}`));
  const requested = await send(
    event("approval", "Request approval before continuing.")
  );
  const accepted = object(await requested.json());
  const conversationId = string(accepted.conversationId);
  const operationId = string(object(accepted.receipt).operationId);
  const press = async (user: string, appId = "test-app") => {
    const payload = {
      actions: [
        {
          action_id: APPROVE_ACTION,
          action_ts: `${user}.1`,
          value: JSON.stringify({
            approvalId: `approval:${operationId}`,
            conversationId,
          }),
        },
      ],
      api_app_id: appId,
      team: { id: "test-workspace" },
      type: "block_actions",
      user: { id: user },
    };
    const raw = new URLSearchParams({
      payload: JSON.stringify(payload),
    }).toString();
    return await app.handler(
      new Request("http://cerebro.test/api/channels/slack/interactions", {
        body: raw,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(await signSlackRaw(raw, configuration.signingSecret)),
        },
        method: "POST",
      })
    );
  };
  const unlinked = await press("someone-else");
  assert.equal(unlinked.status, 403);
  const otherApp = await press("slack-user", "other-app");
  assert.equal(otherApp.status, 403);
  const approved = await press("slack-user");
  assert.equal(approved.status, 200);
  assert.equal(object(object(await approved.json()).approval).state, "allowed");
});

const memoryStore = () => {
  const values = new Map<string, SlackDelivery>();
  return {
    get: (key: string) => Promise.resolve(values.get(key)),
    set: async (key: string, delivery: SlackDelivery) => {
      values.set(key, delivery);
      await Promise.resolve();
    },
    values,
  };
};
const fakeSlack = (results: SlackResult[] = []) => {
  const calls: { method: string; text: string; ts?: string }[] = [];
  const next = (): SlackResult =>
    results.shift() ?? { state: "sent", ts: `${calls.length}.0` };
  const api: SlackApi = {
    edit: (message) => {
      calls.push({ method: "update", text: message.text, ts: message.ts });
      return Promise.resolve(next());
    },
    send: (message) => {
      calls.push({ method: "postMessage", text: message.text });
      return Promise.resolve(next());
    },
    sendEphemeral: (message) => {
      calls.push({ method: "postEphemeral", text: message.text });
      return Promise.resolve(next());
    },
  };
  return { api, calls };
};
const address = {
  agentId: id.agent("agent"),
  conversationId: id.conversation("conversation"),
  organizationId: id.organization("company"),
  sessionId: id.session("session"),
};
const thread = {
  channelId: "D-test",
  conversationId: "conversation",
  threadTs: "1.0",
};
const answerSnapshot = (text: string) =>
  chatSnapshot(address, {
    messages: [{ id: "answer-1", role: "assistant", state: "complete", text }],
  });

test("Slack delivery posts each complete native message once and omits partial text", async () => {
  const store = memoryStore();
  const slack = fakeSlack();
  const deliver = (snapshot: ReturnType<typeof chatSnapshot>) =>
    deliverSlackReplies({
      canShare: () => Promise.resolve(true),
      slack: slack.api,
      snapshot,
      store,
      thread,
    });
  await deliver(
    chatSnapshot(address, {
      busy: true,
      messages: [
        {
          id: "partial-1",
          role: "assistant",
          state: "streaming",
          text: "Incomplete",
        },
      ],
    })
  );
  const final = answerSnapshot(
    "**Refunds** take [five days](https://example.test)."
  );
  await deliver(final);
  await deliver(final);
  assert.deepEqual(slack.calls, [
    {
      method: "postMessage",
      text: "*Refunds* take <https://example.test|five days>.",
    },
  ]);
});

test("Slack delivery replaces an answer when the recipient loses access", async () => {
  const slack = fakeSlack();
  const store = memoryStore();
  const snapshot = answerSnapshot("Private answer");
  await deliverSlackReplies({
    canShare: () => Promise.resolve(true),
    slack: slack.api,
    snapshot,
    store,
    thread,
  });
  await deliverSlackReplies({
    canShare: () => Promise.resolve(false),
    slack: slack.api,
    snapshot,
    store,
    thread,
  });
  assert.deepEqual(slack.calls, [
    { method: "postMessage", text: "Private answer" },
    {
      method: "update",
      text: "I can no longer share this answer because your access changed.",
      ts: "1.0",
    },
  ]);
});

const approvalSnapshot = (state: "pending" | "allowed") =>
  chatSnapshot(address, {
    approvals: [
      {
        approvalId: "approval-1",
        arguments: { ticket: "T-1" },
        callId: "call-1",
        expiresAt: 10,
        operationId: "operation-1",
        state,
        taskId: "task-1",
        toolId: "create_ticket",
      },
    ],
    busy: true,
  });

test("Slack delivery shows native approval buttons and edits them to the final decision", async () => {
  const store = memoryStore();
  const slack = fakeSlack();
  const deliver = (state: "pending" | "allowed") =>
    deliverSlackReplies({
      canShare: () => Promise.resolve(true),
      slack: slack.api,
      snapshot: approvalSnapshot(state),
      store,
      thread,
    });
  await deliver("pending");
  await deliver("allowed");
  assert.deepEqual(slack.calls, [
    { method: "postMessage", text: "Approve `create_ticket`?" },
    { method: "update", text: "Approved: `create_ticket`", ts: "1.0" },
  ]);
});

test("Slack delivery never repeats an uncertain post and retries when rate limited", async () => {
  const store = memoryStore();
  const snapshot = answerSnapshot("Complete answer.");
  const uncertain = fakeSlack([{ state: "unknown" }]);
  const deliver = (api: SlackApi) =>
    deliverSlackReplies({
      canShare: () => Promise.resolve(true),
      slack: api,
      snapshot,
      store,
      thread,
    });
  await deliver(uncertain.api);
  await deliver(uncertain.api);
  assert.deepEqual(uncertain.calls, [
    { method: "postMessage", text: "Complete answer." },
  ]);
  const limited = fakeSlack([{ state: "retry" }]);
  const fresh = memoryStore();
  await assert.rejects(
    deliverSlackReplies({
      canShare: () => Promise.resolve(true),
      slack: limited.api,
      snapshot,
      store: fresh,
      thread,
    })
  );
  await deliverSlackReplies({
    canShare: () => Promise.resolve(true),
    slack: limited.api,
    snapshot,
    store: fresh,
    thread,
  });
  assert.equal(fresh.values.get("message:answer-1")?.state, "sent");
  assert.deepEqual(
    limited.calls.map((call) => call.text),
    ["Complete answer.", "Complete answer."]
  );
});

test("Slack recovery does not repeat a post whose local outcome was lost", async () => {
  const store = memoryStore();
  const slack = fakeSlack();
  let crash = true;
  const input = {
    snapshot: answerSnapshot("Complete answer."),
    thread,
    slack: slack.api,
    canShare: () => Promise.resolve(true),
    store: {
      get: store.get,
      set: async (key: string, delivery: SlackDelivery) => {
        if (delivery.state === "sent" && crash) {
          crash = false;
          throw new Error("Lost host after the external post");
        }
        await store.set(key, delivery);
      },
    },
  };
  await assert.rejects(deliverSlackReplies(input), /Lost host/u);
  const retained = await store.get("message:answer-1");
  assert.equal(retained?.state, "unknown");
  await deliverSlackReplies(input);
  assert.deepEqual(slack.calls, [
    { method: "postMessage", text: "Complete answer." },
  ]);
});

test("the Slack client classifies delivery results", async () => {
  const responses = [
    Response.json({ ok: true, ts: "1.0" }),
    Response.json({ error: "channel_not_found", ok: false }),
    new Response("slow down", { status: 429 }),
    new Response("down", { status: 503 }),
  ];
  const urls: string[] = [];
  const api = createSlackApi(
    {
      ...slackConfiguration(),
      apiUrl: "http://slack.test/api/chat.postMessage",
    },
    (input) => {
      urls.push(String(input));
      const response = responses.shift();
      return response
        ? Promise.resolve(response)
        : Promise.reject(new Error("offline"));
    }
  );
  const message = { channel: "D-test", text: "Hi" };
  assert.deepEqual(await api.send(message), { state: "sent", ts: "1.0" });
  assert.deepEqual(await api.send(message), {
    error: "channel_not_found",
    state: "failed",
  });
  assert.deepEqual(await api.send(message), { state: "retry" });
  assert.deepEqual(await api.send(message), { state: "unknown" });
  assert.deepEqual(await api.send(message), { state: "unknown" });
  assert.equal(urls[0], "http://slack.test/api/chat.postMessage");
  assert.equal(toSlackText("# Title"), "*Title*");
});
