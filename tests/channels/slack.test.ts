import { test } from "bun:test";
import assert from "node:assert/strict";

import { digest } from "../../packages/channels/src/security";
import { createSlackApi } from "../../packages/channels/src/slack-api";
import { toSlackText } from "../../packages/contracts/src/slack-text.ts";
import { createIdentityRepository } from "../../packages/db/src/repositories/identity";
import {
  channelConversation,
  channelLinkEvent,
} from "../../packages/db/src/schema/agents";
import { fixtureSubmissionCount } from "./fixture-session";
import {
  createTestProduct,
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
    ts: eventId === "link" ? "1.000000" : "2.000000",
    type: "message",
    user: "slack-user",
    ...overrides,
  },
  event_id: eventId,
  team_id: "test-workspace",
  type: "event_callback",
});

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

test("Slack linking, event replay, and primary continuity persist in PostgreSQL", async () => {
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
    [200, 200],
    await accepted[0]?.clone().text()
  );
  assert.equal(fixtureSubmissionCount(), 1);
  const followup = event("message-two", "Continue in this thread.", "2.000000");
  const continued = await send(followup);
  assert.equal(continued.status, 200);
  await app.options.withDatabase(async (db) => {
    const conversations = await db.select().from(channelConversation);
    assert.equal(conversations.length, 1);
  });
  const changed = await send(event("message-one", "Changed text"));
  assert.equal(changed.status, 409);
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
  const denied = await send(event("denied", "Denied message", "2.000000"));
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
  const retried = event("unlinked", "Hello");
  await send(retried, {
    ...(await signSlack(retried, slackConfiguration().signingSecret)),
    "x-slack-retry-num": "1",
  });
  assert.equal(slack.calls.length, 3);
});

test("Slack adapters without a queue await admission even when background work is available", async () => {
  const { app, code, configuration, principalId, send } = await linkedProduct();
  await send(event("link", `link ${code}`));
  const pending: Promise<unknown>[] = [];
  const background = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
  };
  const submit = async (body: unknown) => {
    const raw = JSON.stringify(body);
    return await app.handler(
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
  };
  const response = await submit(
    event("foreground", "Admit before responding.")
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(object(await response.json()).accepted, true);
  assert.equal(fixtureSubmissionCount(), 1);
  assert.equal(pending.length, 0);
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
  const denied = await submit(event("denied-foreground", "This cannot start."));
  assert.equal(denied.status, 403);
  assert.equal(fixtureSubmissionCount(), 1);
  assert.equal(pending.length, 0);
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
