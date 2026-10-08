import { test } from "bun:test";
import assert from "node:assert/strict";

import { Effect } from "effect";

import { drainChannelWork } from "../../packages/channels/src/drain";
import { createFixtureSessionService } from "../../packages/channels/src/fixture-session";
import { digest } from "../../packages/channels/src/security";
import { id } from "../../packages/contracts/src/index";
import type { RunState } from "../../packages/contracts/src/index";
import { eq } from "../../packages/db/node_modules/drizzle-orm";
import { createIdentityRepository } from "../../packages/db/src/repositories/identity";
import {
  channelConversation,
  channelFixtureRun,
  channelInbox,
  channelLinkEvent,
  channelReply,
} from "../../packages/db/src/schema/agents";
import {
  createTestProduct,
  domainSnapshot,
  object,
  signSlack,
  string,
} from "./helpers";

const slackConfiguration = () => ({
  agentId: "unset",
  apiUrl: "http://slack.test/post",
  appId: "test-app",
  botToken: "test-bot-token",
  signingSecret: "test-signing-secret",
  workspaceId: "test-workspace",
});
const event = (eventId: string, text: string, threadTimestamp?: string) => ({
  api_app_id: "test-app",
  event: {
    channel: "D-test",
    channel_type: "im",
    text,
    ...(threadTimestamp ? { thread_ts: threadTimestamp } : {}),
    ts: eventId === "link" ? "1.0" : "2.0",
    type: "message",
    user: "slack-user",
  },
  event_id: eventId,
  team_id: "test-workspace",
  type: "event_callback",
});

test("signed Slack identity linking, inbox replay, thread sessions, and outbox delivery persist in PostgreSQL", async () => {
  const configuration = slackConfiguration();
  let delivered = 0;
  const app = await createTestProduct(configuration, () => {
    delivered += 1;
    return Response.json({ channel: "D-test", ok: true, ts: "reply-1" });
  });
  const setup = await app.install();
  const principalId = string(setup.principalId);
  const verifiedResult1 = await app.createAgent();
  configuration.agentId = string(verifiedResult1.agentId);
  const code = "a".repeat(64);
  const codeDigest = await digest(code);
  await app.options.withDatabase((db) =>
    createIdentityRepository(db).createSlackLinkChallenge(
      app.options.organizationId,
      principalId,
      codeDigest,
      new Date(Date.now() + 60_000)
    )
  );
  const linkEvent = event("link", `link ${code}`);
  const linkResponses = await Promise.all([
    app.request(
      "/api/channels/slack/events",
      "POST",
      linkEvent,
      null,
      await signSlack(linkEvent, configuration.signingSecret)
    ),
    app.request(
      "/api/channels/slack/events",
      "POST",
      linkEvent,
      null,
      await signSlack(linkEvent, configuration.signingSecret)
    ),
  ]);
  assert.deepEqual(
    linkResponses.map((response) => response.status),
    [200, 200]
  );
  await app.options.withDatabase(async (db) => {
    const receipts = await db.select().from(channelLinkEvent);
    assert.equal(receipts.length, 1);
    assert.equal(JSON.stringify(receipts).includes(code), false);
    const verifiedResult2 = await db.select().from(channelInbox);
    assert.equal(verifiedResult2.length, 0);
  });
  const message = event("message-one", "Describe the pilot source.");
  const headers = await signSlack(message, configuration.signingSecret);
  const accepted = await Promise.all([
    app.request("/api/channels/slack/events", "POST", message, null, headers),
    app.request("/api/channels/slack/events", "POST", message, null, headers),
  ]);
  assert.deepEqual(
    accepted.map((response) => response.status),
    [200, 200]
  );
  await app.options.withDatabase(async (db) => {
    const verifiedResult3 = await db.select().from(channelInbox);
    assert.equal(verifiedResult3.length, 1);
    const verifiedResult4 = await db.select().from(channelFixtureRun);
    assert.equal(verifiedResult4.length, 1);
    const verifiedResult5 = await db.select().from(channelReply);
    assert.equal(verifiedResult5.length, 0);
  });
  assert.deepEqual(await drainChannelWork(app.options), {
    sent: 1,
    submitted: 0,
    unknown: 0,
  });
  assert.deepEqual(await drainChannelWork(app.options), {
    sent: 0,
    submitted: 0,
    unknown: 0,
  });
  assert.equal(delivered, 1);
  const followup = event("message-two", "Continue in this thread.", "2.0");
  const verifiedResult6 = await app.request(
    "/api/channels/slack/events",
    "POST",
    followup,
    null,
    await signSlack(followup, configuration.signingSecret)
  );
  assert.equal(verifiedResult6.status, 200);
  await app.options.withDatabase(async (db) => {
    const verifiedResult7 = await db.select().from(channelConversation);
    assert.equal(verifiedResult7.length, 1);
  });
  const changed = event("message-one", "Changed text");
  const verifiedResult8 = await app.request(
    "/api/channels/slack/events",
    "POST",
    changed,
    null,
    await signSlack(changed, configuration.signingSecret)
  );
  assert.equal(verifiedResult8.status, 409);
  const verifiedResult9 = await app.request(
    "/api/channels/slack/events",
    "POST",
    message,
    null,
    {
      ...headers,
      "x-slack-signature": `v0=${"0".repeat(64)}`,
    }
  );
  assert.equal(verifiedResult9.status, 401);
  const verifiedResult10 = await app.request(
    "/api/channels/slack/events",
    "POST",
    message,
    null,
    await signSlack(message, configuration.signingSecret, "1")
  );
  assert.equal(verifiedResult10.status, 401);
  const shared = {
    ...message,
    event: { ...message.event, channel: "C-test", channel_type: "channel" },
    event_id: "shared",
  };
  const verifiedResult11 = await app.request(
    "/api/channels/slack/events",
    "POST",
    shared,
    null,
    await signSlack(shared, configuration.signingSecret)
  );
  assert.equal(verifiedResult11.status, 403);
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
  const denied = event("denied", "Denied message", "2.0");
  const verifiedResult12 = await app.request(
    "/api/channels/slack/events",
    "POST",
    denied,
    null,
    await signSlack(denied, configuration.signingSecret)
  );
  assert.equal(verifiedResult12.status, 403);
  await app.options.withDatabase((db) =>
    createIdentityRepository(db).setManualGrant(
      app.options.organizationId,
      principalId,
      {
        action: "read",
        resourceId: configuration.agentId,
        resourceKind: "agent",
      },
      false
    )
  );
  await drainChannelWork(app.options);
  assert.equal(delivered, 1);
});

test("ambiguous Slack delivery and abandoned claims never retry automatically", async () => {
  const configuration = slackConfiguration();
  let attempts = 0;
  const app = await createTestProduct(configuration, () => {
    attempts += 1;
    throw new Error("The provider accepted before connection loss.");
  });
  const verifiedResult13 = await app.install();
  const principalId = string(verifiedResult13.principalId);
  const verifiedResult14 = await app.createAgent();
  configuration.agentId = string(verifiedResult14.agentId);
  const code = "b".repeat(64);
  const codeDigest = await digest(code);
  await app.options.withDatabase((db) =>
    createIdentityRepository(db).createSlackLinkChallenge(
      app.options.organizationId,
      principalId,
      codeDigest,
      new Date(Date.now() + 60_000)
    )
  );
  const linkEvent = event("link", `link ${code}`);
  await app.request(
    "/api/channels/slack/events",
    "POST",
    linkEvent,
    null,
    await signSlack(linkEvent, configuration.signingSecret)
  );
  const message = event("uncertain", "Describe the source");
  const verifiedResult15 = await app.request(
    "/api/channels/slack/events",
    "POST",
    message,
    null,
    await signSlack(message, configuration.signingSecret)
  );
  assert.equal(verifiedResult15.status, 200);
  assert.deepEqual(await drainChannelWork(app.options), {
    sent: 0,
    submitted: 0,
    unknown: 1,
  });
  await drainChannelWork(app.options);
  assert.equal(attempts, 1);
  await app.options.withDatabase(async (db) => {
    const rows = await db.select().from(channelReply);
    assert.equal(rows[0]?.state, "unknown-outcome");
    await db
      .update(channelReply)
      .set({
        attemptId: "abandoned",
        startedAt: new Date(Date.now() - 60_000),
        state: "sending",
      })
      .where(eq(channelReply.replyId, rows[0]?.replyId ?? ""));
  });
  assert.deepEqual(await drainChannelWork(app.options), {
    sent: 0,
    submitted: 0,
    unknown: 1,
  });
  assert.equal(attempts, 1);
});

test("one snapshot projects complete canonical text without stream batching", async () => {
  const configuration = slackConfiguration();
  const sentBodies: string[] = [];
  const app = await createTestProduct(configuration, (_request, init) => {
    sentBodies.push(String(init?.body));
    return Response.json({ channel: "D-test", ok: true, ts: "complete-reply" });
  });
  const verifiedResult16 = await app.install();
  const principalId = string(verifiedResult16.principalId);
  const verifiedResult17 = await app.createAgent();
  configuration.agentId = string(verifiedResult17.agentId);
  const code = "c".repeat(64);
  const digestCode = await digest(code);
  await app.options.withDatabase((db) =>
    createIdentityRepository(db).createSlackLinkChallenge(
      app.options.organizationId,
      principalId,
      digestCode,
      new Date(Date.now() + 60_000)
    )
  );
  const linked = event("link", `link ${code}`);
  const verifiedResult18 = await app.request(
    "/api/channels/slack/events",
    "POST",
    linked,
    null,
    await signSlack(linked, configuration.signingSecret)
  );
  assert.equal(verifiedResult18.status, 200);
  await app.options.withDatabase((db) =>
    db.insert(channelConversation).values({
      agentId: configuration.agentId,
      bindingKey: "remote-binding",
      channelId: "D-test",
      conversationId: "remote-conversation",
      engine: "pi-v1",
      kind: "slack",
      organizationId: app.options.organizationId,
      ownerPrincipalId: principalId,
      projectionState: "active",
      rootTimestamp: "4.0",
      sessionId: "remote-session",
      slackUserId: "slack-user",
      workspaceId: configuration.workspaceId,
    })
  );
  const run: RunState = {
    completedAt: Date.now(),
    runId: id.run("remote-run"),
    state: "completed",
  };
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
            executions: [
              { executionId: "remote-execution", runIds: [run.runId] },
            ],
            outputs: [
              {
                answerId: "remote-answer",
                citations: [],
                dependencies: { sourceIds: [], toolIds: [] },
                executionId: "remote-execution",
                runId: run.runId,
                runIds: [run.runId],
                text: "x".repeat(105),
              },
            ],
            revision: 106,
            runs: [run],
          })
        ),
    }),
  };
  assert.deepEqual(await drainChannelWork(options), {
    sent: 1,
    submitted: 0,
    unknown: 0,
  });
  assert.equal(sentBodies.length, 1);
  assert.equal(object(JSON.parse(sentBodies[0] ?? "{}")).text, "x".repeat(105));
  await drainChannelWork(options);
  assert.equal(sentBodies.length, 1);
});

test("one snapshot per pass keeps active work and then projects one joined answer", async () => {
  const configuration = slackConfiguration();
  const app = await createTestProduct(configuration, () =>
    Promise.resolve(
      Response.json({ channel: "D-test", ok: true, ts: "race-reply" })
    )
  );
  const setup = await app.install();
  const principalId = string(setup.principalId);
  const verifiedResult1001 = await app.createAgent();
  const agentId = string(verifiedResult1001.agentId);
  configuration.agentId = agentId;
  const code = "d".repeat(64);
  const codeDigest = await digest(code);
  await app.options.withDatabase((db) =>
    createIdentityRepository(db).createSlackLinkChallenge(
      app.options.organizationId,
      principalId,
      codeDigest,
      new Date(Date.now() + 60_000)
    )
  );
  const linkEvent = event("link", `link ${code}`);
  const verifiedResult1002 = await app.request(
    "/api/channels/slack/events",
    "POST",
    linkEvent,
    null,
    await signSlack(linkEvent, configuration.signingSecret)
  );
  assert.equal(verifiedResult1002.status, 200);
  await app.options.withDatabase((db) =>
    db.insert(channelConversation).values({
      agentId,
      bindingKey: "race-binding",
      channelId: "D-test",
      conversationId: "race-conversation",
      engine: "pi-v1",
      kind: "slack",
      organizationId: app.options.organizationId,
      ownerPrincipalId: principalId,
      projectionState: "active",
      rootTimestamp: "5.0",
      sessionId: "race-session",
      slackUserId: "slack-user",
      workspaceId: configuration.workspaceId,
    })
  );
  const runId = id.run("race-run");
  const completed: RunState = {
    completedAt: Date.now(),
    runId,
    state: "completed",
  };
  let inspections = 0;
  const joinedRunId = id.run("joined-run");
  const options = {
    ...app.options,
    sessions: (db: Parameters<typeof createFixtureSessionService>[0]) => ({
      ...createFixtureSessionService(db, app.options),
      inspect: (
        address: Parameters<
          ReturnType<typeof createFixtureSessionService>["inspect"]
        >[0]
      ) => {
        inspections += 1;
        return Effect.succeed(
          domainSnapshot(address, {
            executions: [
              { executionId: "joined-execution", runIds: [runId, joinedRunId] },
            ],
            outputs:
              inspections === 1
                ? []
                : [
                    {
                      answerId: "joined-answer",
                      citations: [],
                      dependencies: { sourceIds: [], toolIds: [] },
                      executionId: "joined-execution",
                      runId,
                      runIds: [runId, joinedRunId],
                      text: "Complete result",
                    },
                  ],
            revision: inspections,
            runs:
              inspections === 1
                ? [
                    { runId, state: "running" },
                    { runId: joinedRunId, state: "queued" },
                  ]
                : [
                    completed,
                    {
                      completedAt: Date.now(),
                      runId: joinedRunId,
                      state: "completed",
                    },
                  ],
          })
        );
      },
      stream: () => {
        throw new Error(
          "Channel projection must not open a live observation stream."
        );
      },
    }),
  };
  assert.deepEqual(await drainChannelWork(options), {
    sent: 0,
    submitted: 0,
    unknown: 0,
  });
  await app.options.withDatabase(async (db) => {
    const conversations = await db.select().from(channelConversation);
    assert.equal(conversations[0]?.projectionState, "active");
    const verifiedResult1003 = await db.select().from(channelReply);
    assert.equal(verifiedResult1003.length, 0);
  });
  assert.deepEqual(await drainChannelWork(options), {
    sent: 1,
    submitted: 0,
    unknown: 0,
  });
  await app.options.withDatabase(async (db) => {
    const conversations = await db.select().from(channelConversation);
    assert.equal(conversations[0]?.projectionState, "idle");
    const replies = await db.select().from(channelReply);
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.replyId, "reply:joined-answer");
    assert.equal(replies[0]?.text, "Complete result");
    assert.equal(inspections, 2);
  });
});
