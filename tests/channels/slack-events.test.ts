import { test } from "bun:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import { Schema } from "effect";

import { createApiHandler } from "../../packages/api/src/handler";
import { assertQueuePayloadSize } from "../../packages/channels/src/queue-payload";
import { digest } from "../../packages/channels/src/security";
import { receiveQueuedSlackEvent } from "../../packages/channels/src/slack";
import { parseSlackEventDecision } from "../../packages/channels/src/slack-event-receipts";
import {
  normalizeSlackDelivery,
  parseSlackQueueDelivery,
} from "../../packages/channels/src/slack-events";
import type { SlackQueueDelivery } from "../../packages/channels/src/slack-events";
import type { ChannelOptions } from "../../packages/channels/src/types";
import { BotEventAddressSchema } from "../../packages/contracts/src/bot-events";
import type { EventAddress } from "../../packages/contracts/src/events";
import { createIdentityRepository } from "../../packages/db/src/repositories/identity";
import {
  channelConversation,
  channelSlackEventReceipt,
} from "../../packages/db/src/schema/agents";
import {
  identityPrincipal,
  identitySlackLink,
} from "../../packages/db/src/schema/identity";
import { fixtureSubmissionCount } from "./fixture-session";
import { saveLegacySlackDecision } from "./fixture-slack-events";
import { createTestProduct, object, array, signSlack, string } from "./helpers";

const configuration = () => ({
  agentId: "agent-A",
  apiUrl: "http://slack.test/api",
  appId: "app-A",
  botToken: "private-bot-token",
  signingSecret: "private-slack-signing-secret",
  workspaceId: "workspace-A",
});
const primaryEvent = (value: unknown) => object(array(object(value).events)[0]);
const primaryConversationId = (value: unknown) =>
  string(object(primaryEvent(value).address).conversationId);
const eventPayload = (eventId: string, text = "Read the policy.") => ({
  api_app_id: "app-A",
  event: {
    channel: "D-A",
    channel_type: "im",
    text,
    ts: "1800000000.000001",
    type: "message",
    user: "slack-user-A",
  },
  event_id: eventId,
  team_id: "workspace-A",
  type: "event_callback",
});
const queuedProduct = async (
  sessions?: Parameters<typeof createTestProduct>[2],
  events?: (
    base: NonNullable<ChannelOptions["slackEvents"]>
  ) => NonNullable<ChannelOptions["slackEvents"]>
) => {
  const slack = configuration();
  const sent: unknown[] = [];
  const app = await createTestProduct(
    slack,
    (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Promise.resolve(
        Response.json({ ok: true, ts: "1800000000.000002" })
      );
    },
    sessions
  );
  const deliveries: SlackQueueDelivery[] = [];
  const options = {
    ...app.options,
    slackEvents:
      events && app.options.slackEvents
        ? events(app.options.slackEvents)
        : app.options.slackEvents,
  };
  const handler = createApiHandler({
    ...options,
    enqueueSlackEvent: (delivery) => {
      deliveries.push(delivery);
      return Promise.resolve();
    },
  });
  const request = async (body: unknown, retry = false) =>
    handler(
      new Request("http://cerebro.test/api/channels/slack/events", {
        body: JSON.stringify(body),
        headers: {
          ...(await signSlack(body, slack.signingSecret)),
          ...(retry ? { "x-slack-retry-num": "1" } : {}),
        },
        method: "POST",
      })
    );
  const consume = (delivery: SlackQueueDelivery, redelivery = false) =>
    app.options.withDatabase((db) =>
      receiveQueuedSlackEvent(db, options, delivery, redelivery)
    );
  const nextDelivery = () => {
    const delivery = deliveries.shift();
    assert.ok(delivery);
    return delivery;
  };
  return {
    app,
    consume,
    deliveries,
    handler,
    nextDelivery,
    request,
    sent,
    slack,
  };
};

const linkOwner = async (
  product: Awaited<ReturnType<typeof queuedProduct>>
) => {
  const setup = await product.app.install();
  const agent = await product.app.createAgent();
  product.slack.agentId = string(agent.agentId);
  const principalId = string(setup.principalId);
  const code = "d".repeat(64);
  await product.app.options.withDatabase(async (db) =>
    createIdentityRepository(db).createSlackLinkChallenge(
      product.app.options.organizationId,
      principalId,
      await digest(code),
      new Date(Date.now() + 60_000)
    )
  );
  await product.request(eventPayload("receipt-link", `link ${code}`));
  await product.consume(product.nextDelivery());
  return principalId;
};

test("an ignored unlinked delivery stays ignored after normal account linking", async () => {
  const product = await queuedProduct();
  await product.app.install();
  const agent = await product.app.createAgent();
  product.slack.agentId = string(agent.agentId);
  await product.request(eventPayload("unlinked-before-link"));
  const original = product.nextDelivery();
  assert.deepEqual(await product.consume(original), { linked: false });
  await linkOwner(product);
  assert.deepEqual(await product.consume(original, true), { linked: false });
  assert.equal(fixtureSubmissionCount(), 0);
});

const createBotSource = async (
  product: Awaited<ReturnType<typeof queuedProduct>>,
  name: string
) => {
  const created = await product.app.request("/api/product/agents", "POST", {
    ...product.app.agentBody,
    name,
    operationId: `create-${name}`,
  });
  assert.equal(created.status, 200, await created.clone().text());
  const agentId = string(object(await created.json()).agentId);
  const opened = await product.app.request(
    "/api/product/conversations",
    "POST",
    { agentId, operationId: `open-${name}` }
  );
  assert.equal(opened.status, 200, await opened.clone().text());
  const conversationId = string(object(await opened.json()).conversationId);
  const [row] = await product.app.options.withDatabase((database) =>
    database
      .select()
      .from(channelConversation)
      .where(eq(channelConversation.conversationId, conversationId))
  );
  assert.ok(row);
  return Schema.decodeUnknownSync(BotEventAddressSchema)(row);
};

test("two explicit bots freeze one target each and replay after default and subscription changes", async () => {
  let targets: readonly EventAddress[] = [];
  let discoveries = 0;
  const product = await queuedProduct(undefined, (base) => ({
    ...base,
    discover: () => {
      discoveries += 1;
      return Promise.resolve(targets);
    },
  }));
  await linkOwner(product);
  const second = await createBotSource(product, "second");
  const third = await createBotSource(product, "third");
  targets = [second, third, second];
  await product.request(eventPayload("frozen-fanout"));
  const delivery = product.nextDelivery();
  const first = object(await product.consume(delivery));
  assert.deepEqual(
    array(first.events).map((value) => object(object(value).address)),
    [second, third]
  );
  assert.equal(fixtureSubmissionCount(), 2);
  assert.equal(discoveries, 1);
  targets = [];
  product.slack.agentId = "a-new-unconfigured-default";
  const replay = object(await product.consume(delivery, true));
  assert.deepEqual(
    array(replay.events).map((value) => object(object(value).address)),
    [second, third]
  );
  assert.equal(discoveries, 1);
  assert.equal(fixtureSubmissionCount(), 2);
  await product.request(eventPayload("frozen-fanout"), true);
  await product.consume(product.nextDelivery(), true);
  assert.equal(discoveries, 1);
  assert.equal(fixtureSubmissionCount(), 2);
  await assert.rejects(
    product.consume(
      {
        ...delivery,
        event: { ...delivery.event, text: "Changed physical callback." },
      },
      true
    ),
    /changed/u
  );
});

test("an empty explicit lookup chooses the same primary as web and a second Slack thread", async () => {
  const product = await queuedProduct();
  await linkOwner(product);
  await product.request(eventPayload("default-one"));
  const first = await product.consume(product.nextDelivery());
  const secondPayload = eventPayload("default-two");
  await product.request({
    ...secondPayload,
    event: { ...secondPayload.event, ts: "1800000002.000001" },
  });
  const second = await product.consume(product.nextDelivery());
  const web = await product.app.request("/api/product/conversations", "POST", {
    agentId: product.slack.agentId,
    operationId: "web-open-shared",
  });
  assert.equal(web.status, 200);
  const opened = object(await web.json());
  assert.equal(primaryConversationId(first), primaryConversationId(second));
  assert.equal(opened.conversationId, primaryConversationId(first));
  const rows = await product.app.options.withDatabase((database) =>
    database.select().from(channelConversation)
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "web");
});

test("a historical subscribed source selects that bot's canonical primary without rewriting old work sources", async () => {
  let targets: readonly EventAddress[] = [];
  const product = await queuedProduct(undefined, (base) => ({
    ...base,
    discover: () => Promise.resolve(targets),
  }));
  const ownerPrincipalId = await linkOwner(product);
  const bot = await createBotSource(product, "historical-bot");
  const legacyOptions = {
    ...product.app.options,
    slack: { ...product.slack, agentId: bot.agentId },
  };
  const legacy = await saveLegacySlackDecision(
    legacyOptions,
    eventPayload("retained-thread"),
    ownerPrincipalId
  );
  targets = [Schema.decodeUnknownSync(BotEventAddressSchema)(legacy.address)];
  await product.request(eventPayload("fresh-event"));
  const accepted = await product.consume(product.nextDelivery());
  assert.equal(primaryConversationId(accepted), bot.conversationId);
  assert.notEqual(
    primaryConversationId(accepted),
    legacy.address.conversationId
  );
  const [old] = await product.app.options.withDatabase((database) =>
    database
      .select()
      .from(channelConversation)
      .where(
        eq(channelConversation.conversationId, legacy.address.conversationId)
      )
  );
  assert.equal(old?.kind, "slack");
});

test("literal legacy decisions keep their original digest and reject a changed default", async () => {
  const product = await queuedProduct();
  const owner = await linkOwner(product);
  const payload = eventPayload("literal-legacy");
  const retained = await saveLegacySlackDecision(
    product.app.options,
    payload,
    owner
  );
  await product.request(payload);
  const delivery = product.nextDelivery();
  const accepted = object(await product.consume(delivery));
  assert.equal(accepted.conversationId, retained.address.conversationId);
  const [before] = await product.app.options.withDatabase((database) =>
    database
      .select()
      .from(channelSlackEventReceipt)
      .where(eq(channelSlackEventReceipt.eventKey, retained.eventKey))
  );
  assert.ok(before);
  assert.equal(parseSlackEventDecision(before.decision).kind, "admit");
  product.slack.agentId = "new-default";
  await assert.rejects(product.consume(delivery, true), /configured agent/u);
  await product.request(payload, true);
  await assert.rejects(
    product.consume(product.nextDelivery(), true),
    /changed/u
  );
  const [after] = await product.app.options.withDatabase((database) =>
    database
      .select()
      .from(channelSlackEventReceipt)
      .where(eq(channelSlackEventReceipt.eventKey, retained.eventKey))
  );
  assert.deepEqual(after, before);
});

test("the provider event ID cannot be reused with a different logical payload", async () => {
  const product = await queuedProduct();
  await linkOwner(product);
  await product.request(eventPayload("digest-bound", "Original request."));
  const original = product.nextDelivery();
  const outcomes = await Promise.all([
    product.consume(original),
    product.consume(original),
  ]);
  assert.equal(object(outcomes[0]).accepted, true);
  assert.equal(
    object(outcomes[1]).conversationId,
    object(outcomes[0]).conversationId
  );
  await assert.rejects(
    product.consume({
      ...original,
      event: { ...original.event, text: "Changed request." },
    }),
    /changed/u
  );
  await assert.rejects(
    product.consume({
      ...original,
      event: { ...original.event, text: `link ${"e".repeat(64)}` },
    }),
    /changed/u
  );
  assert.equal(fixtureSubmissionCount(), 1);
});

test("an operator link change cannot retarget an admitted provider event", async () => {
  const product = await queuedProduct();
  const principalId = await linkOwner(product);
  await product.request(eventPayload("fixed-target"));
  const original = product.nextDelivery();
  const admitted = object(await product.consume(original));
  const eventKey = `slack:${product.app.options.organizationId}:${product.slack.appId}:${product.slack.workspaceId}:fixed-target`;
  const before = await product.app.options.withDatabase(async (db) => {
    const [receipt] = await db
      .select()
      .from(channelSlackEventReceipt)
      .where(eq(channelSlackEventReceipt.eventKey, eventKey));
    await db.insert(identityPrincipal).values({
      id: "operator-target-principal",
      kind: "human",
      organizationId: product.app.options.organizationId,
      state: "active",
    });
    await db
      .update(identitySlackLink)
      .set({ principalId: "operator-target-principal" })
      .where(eq(identitySlackLink.principalId, principalId));
    return receipt;
  });
  assert.ok(before);
  await assert.rejects(product.consume(original, true), /target.*accessible/u);
  const after = await product.app.options.withDatabase(async (db) => {
    const rows = await db.select().from(channelConversation);
    const [receipt] = await db
      .select()
      .from(channelSlackEventReceipt)
      .where(eq(channelSlackEventReceipt.eventKey, eventKey));
    return { receipt, rows };
  });
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0]?.conversationId, primaryConversationId(admitted));
  assert.deepEqual(after.receipt?.decision, before.decision);
  assert.equal(fixtureSubmissionCount(), 1);
});

test("a committed routing decision retries Pi admission after interruption and concurrent replay", async () => {
  let interrupt = true;
  const product = await queuedProduct((client) => ({
    ...client,
    send: (input) => {
      if (interrupt) {
        interrupt = false;
        return Promise.reject(new Error("Interrupted before Pi admission"));
      }
      return client.send(input);
    },
  }));
  await linkOwner(product);
  await product.request(eventPayload("decision-before-submit"));
  const original = product.nextDelivery();
  await assert.rejects(product.consume(original), /Interrupted before Pi/u);
  const bindings = await product.app.options.withDatabase((db) =>
    db.select().from(channelConversation)
  );
  assert.equal(bindings.length, 1);
  assert.equal(fixtureSubmissionCount(), 0);
  const outcomes = await Promise.all([
    product.consume(original, true),
    product.consume(original, true),
  ]);
  assert.deepEqual(outcomes.map(primaryConversationId), [
    bindings[0]?.conversationId,
    bindings[0]?.conversationId,
  ]);
  assert.equal(fixtureSubmissionCount(), 1);
});

test("Slack HTTP success waits for the queue commit and does not open the database", async () => {
  const { app, slack } = await queuedProduct();
  const entered = Promise.withResolvers<boolean>();
  const commit = Promise.withResolvers<boolean>();
  let responded = false;
  let databases = 0;
  const saved: SlackQueueDelivery[] = [];
  const handler = createApiHandler({
    ...app.options,
    enqueueSlackEvent: async (delivery) => {
      saved.push(delivery);
      entered.resolve(true);
      await commit.promise;
    },
    withDatabase: () => {
      databases += 1;
      return Promise.reject(new Error("Ingress must not access the database."));
    },
  });
  const body = {
    ...eventPayload("provider-event-A"),
    token: "unneeded-provider-token",
  };
  const request = new Request("http://cerebro.test/api/channels/slack/events", {
    body: JSON.stringify(body),
    headers: await signSlack(body, slack.signingSecret),
    method: "POST",
  });
  const pending = (async () => {
    const response = await handler(request);
    responded = true;
    return response;
  })();
  await entered.promise;
  try {
    assert.equal(responded, false);
    assert.equal(databases, 0);
    assert.equal(saved[0]?.eventId, "provider-event-A");
    assert.equal(saved[0]?.sourceRetry, false);
    assert.equal(JSON.stringify(saved).includes("private-"), false);
    assert.equal(
      JSON.stringify(saved).includes("unneeded-provider-token"),
      false
    );
  } finally {
    commit.resolve(true);
  }
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(fixtureSubmissionCount(), 0);
});

test("queue failure returns non-success while forged requests and challenges never enqueue", async () => {
  const { app, slack } = await queuedProduct();
  let sends = 0;
  const handler = createApiHandler({
    ...app.options,
    enqueueSlackEvent: () => {
      sends += 1;
      return Promise.reject(new Error("Queue unavailable"));
    },
  });
  const body = eventPayload("failed-enqueue");
  const invoke = (value: unknown, headers: Record<string, string>) =>
    handler(
      new Request("http://cerebro.test/api/channels/slack/events", {
        body: JSON.stringify(value),
        headers,
        method: "POST",
      })
    );
  const signed = await signSlack(body, slack.signingSecret);
  const unavailable = await invoke(body, signed);
  assert.equal(unavailable.status, 503);
  const forged = await invoke(body, {
    ...signed,
    "x-slack-signature": `v0=${"0".repeat(64)}`,
  });
  assert.equal(forged.status, 401);
  const challenge = { challenge: "verify-A", type: "url_verification" };
  const verified = await invoke(
    challenge,
    await signSlack(challenge, slack.signingSecret)
  );
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), { challenge: "verify-A" });
  assert.equal(sends, 1);
  assert.equal(fixtureSubmissionCount(), 0);
});

test("queued Slack retries keep the provider ID and reuse current durable input admission", async () => {
  const { app, consume, nextDelivery, request, slack } = await queuedProduct();
  const setup = await app.install();
  const agent = await app.createAgent();
  slack.agentId = string(agent.agentId);
  const principalId = string(setup.principalId);
  const code = "c".repeat(64);
  await app.options.withDatabase(async (db) =>
    createIdentityRepository(db).createSlackLinkChallenge(
      app.options.organizationId,
      principalId,
      await digest(code),
      new Date(Date.now() + 60_000)
    )
  );
  const linkedResponse = await request(
    eventPayload("provider-link", `link ${code}`)
  );
  assert.equal(linkedResponse.status, 200);
  assert.equal(object(await consume(nextDelivery())).linked, true);
  const body = eventPayload("provider-message");
  const firstResponse = await request(body);
  assert.equal(firstResponse.status, 200);
  const original = nextDelivery();
  const retryResponse = await request(body, true);
  assert.equal(retryResponse.status, 200);
  const retried = nextDelivery();
  assert.equal(original.eventId, "provider-message");
  assert.equal(retried.eventId, "provider-message");
  assert.equal(retried.sourceRetry, true);
  assert.equal(fixtureSubmissionCount(), 0);
  const first = object(
    await consume({ ...original, receivedAt: original.receivedAt - 600_000 })
  );
  const second = object(await consume(retried, true));
  assert.equal(primaryEvent(first).eventId, primaryEvent(second).eventId);
  assert.equal(fixtureSubmissionCount(), 1);
  await app.options.withDatabase((db) =>
    createIdentityRepository(db).setManualGrant(
      app.options.organizationId,
      principalId,
      { action: "execute", resourceId: slack.agentId, resourceKind: "agent" },
      false
    )
  );
  await request(eventPayload("revoked-later"));
  await assert.rejects(consume(nextDelivery()), /permission|access|grant/iu);
  assert.equal(fixtureSubmissionCount(), 1);
  await assert.rejects(
    consume({ ...original, organizationId: "other-company" }),
    /configuration/u
  );
});

test("queued bot, unsupported and unlinked deliveries never admit model work", async () => {
  const { consume, deliveries, nextDelivery, request, sent } =
    await queuedProduct();
  const body = eventPayload("ignored");
  const events = [
    { ...body.event, bot_id: "bot-A" },
    { ...body.event, type: "reaction_added" },
    { ...body.event, subtype: "message_changed" },
  ];
  await Promise.all(
    events.map((event, index) =>
      request({ ...body, event, event_id: `ignored-${index}` })
    )
  );
  const outcomes = await Promise.all(
    deliveries.splice(0).map((delivery) => consume(delivery))
  );
  assert.deepEqual(outcomes, [
    { ignored: true },
    { ignored: true },
    { ignored: true },
  ]);
  await request(eventPayload("unlinked"));
  assert.deepEqual(await consume(nextDelivery()), { linked: false });
  assert.equal(fixtureSubmissionCount(), 0);
  assert.equal(sent.length, 1);
  assert.match(string(object(sent[0]).text), /Link your Slack account first/u);
});

test("saved Slack envelopes reject extra credentials and queue bounds count encoded UTF-8 bytes", () => {
  const value = normalizeSlackDelivery({
    configuration: configuration(),
    organizationId: "org-A",
    payload: eventPayload("provider-A"),
    receivedAt: 1_800_000_000_000,
    sourceRetry: false,
  });
  assert.equal(parseSlackQueueDelivery(value).eventId, "provider-A");
  assert.throws(() =>
    parseSlackQueueDelivery({ ...value, botToken: "private" })
  );
  assertQueuePayloadSize({ text: "a".repeat(60_000) });
  assert.throws(
    () => assertQueuePayloadSize({ text: "😀".repeat(30_000) }),
    /too large/u
  );
});
