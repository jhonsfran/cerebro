import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { Schema } from "effect";
import { z } from "zod";

import {
  ChatReceipt,
  ChatSnapshot,
} from "../../../packages/contracts/src/session-service.ts";
import {
  applicationFixture,
  readApplicationBoot,
  stackFiles,
  waitForFixture,
} from "../../slice-1/application.ts";

const metadataPath = process.env.CHANNEL_NATIVE_METADATA;
if (!metadataPath) {
  throw new Error(
    "Run tests/channels/native/run.mjs to boot an owned application."
  );
}
const metadata = z
  .object({
    agent: z.object({
      agentId: z.string(),
      organizationId: z.string(),
      principalId: z.string(),
    }),
    bootPath: z.string(),
    owner: z.object({ cookie: z.string() }),
    sourceIdentity: z.string(),
  })
  .parse(JSON.parse(await readFile(metadataPath, "utf-8")));
const boot = await readApplicationBoot(metadata.bootPath);
const fixture = applicationFixture(boot);
const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const compose = (args: readonly string[]) =>
  execute(
    "rtk",
    [
      "proxy",
      "docker",
      "compose",
      "--project-directory",
      root,
      "-p",
      boot.fixtureId,
      ...[...stackFiles, boot.overridePath].flatMap((file) => ["-f", file]),
      ...args,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        CEREBRO_API_PORT: new URL(boot.apiUrl).port,
        CEREBRO_WEB_PORT: new URL(boot.webUrl).port,
        CEREBRO_FIXTURE_PORT: new URL(boot.fixtureUrl).port,
        CEREBRO_FIXTURE_ID: boot.fixtureId,
        CEREBRO_FIXTURE_SHA: boot.sha,
        CEREBRO_PUBLIC_API_URL: boot.apiUrl,
        CEREBRO_PUBLIC_WEB_URL: boot.webUrl,
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
    }
  );
const slack = {
  agentId: metadata.agent.agentId,
  appId: "native-queue-app",
  apiUrl: "http://fixture:8090/slack",
  botToken: "fixture-slack-token",
  signingSecret: "fixture-slack-signing-secret",
  workspaceId: "native-queue-workspace",
};
const eventPayload = (eventId: string, text: string) => ({
  api_app_id: slack.appId,
  event: {
    channel: "D-native-queue",
    channel_type: "im",
    text,
    ts: "1800000000.000001",
    type: "message",
    user: "native-queue-user",
  },
  event_id: eventId,
  team_id: slack.workspaceId,
  type: "event_callback",
});
const send = async (payload: unknown, retry = false) => {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(slack.signingSecret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`v0:${timestamp}:${body}`)
    )
  );
  return await fetch(`${boot.apiUrl}/api/channels/slack/events`, {
    body,
    headers: {
      "Content-Type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
      ...(retry ? { "x-slack-retry-num": "1" } : {}),
    },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
};
const observations = async () =>
  z
    .object({
      model: z.array(
        z.object({
          operationId: z.string(),
          completedAt: z.number().optional(),
        })
      ),
    })
    .parse(await fixture.observations());

test(
  "signed Slack ingress reaches the real queue and admits the original provider event once without a browser wake",
  { timeout: 240_000 },
  async () => {
    await compose([
      "run",
      "--no-deps",
      "--rm",
      "test-config",
      "node",
      "--input-type=module",
      "-e",
      "import {writeFile} from 'node:fs/promises'; await writeFile('/run/cerebro-secrets/channels.json',process.argv[1],{mode:0o600});",
      JSON.stringify({ organizationId: metadata.agent.organizationId, slack }),
    ]);
    await compose([
      "up",
      "--no-deps",
      "--force-recreate",
      "--wait",
      "bootstrap",
    ]);
    await compose(["restart", "celld"]);
    await waitForFixture(
      async () => {
        try {
          const response = await fetch(`${boot.apiUrl}/ready`, {
            signal: AbortSignal.timeout(5000),
          });
          await response.body?.cancel();
          return response.status;
        } catch {
          return 0;
        }
      },
      (status) => status === 200
    );
    const before = await observations();
    const unlinked = eventPayload("native-unlinked", "Do not execute this.");
    const bot = eventPayload("native-bot", "Do not execute this.");
    const rejected = await Promise.all([
      send(unlinked),
      send({ ...bot, event: { ...bot.event, bot_id: "bot-A" } }),
      send({
        ...bot,
        event_id: "native-unsupported",
        event: { ...bot.event, type: "reaction_added" },
      }),
    ]);
    assert.deepEqual(
      rejected.map((response) => response.status),
      [200, 200, 200]
    );
    await Promise.all(rejected.map((response) => response.body?.cancel()));
    const ignoredReceipt = await waitForFixture(
      () =>
        fixture.sql(
          "SELECT decision->>'reason' FROM channel_slack_event_receipt WHERE event_key LIKE '%:native-unlinked'"
        ),
      (reason) => reason === "unlinked"
    );
    const link = await fixture.json(
      "/rpc/identity/beginSlackLink",
      metadata.owner.cookie,
      z.object({ json: z.object({ code: z.string() }) }),
      { json: { organizationId: metadata.agent.organizationId } }
    );
    const linked = await send(
      eventPayload("native-link", `link ${link.json.code}`)
    );
    assert.equal(linked.status, 200);
    await linked.body?.cancel();
    await waitForFixture(
      () =>
        fixture.sql(
          "SELECT count(*) FROM identity_slack_link WHERE workspace_id='native-queue-workspace' AND slack_user_id='native-queue-user'"
        ),
      (count) => count === "1"
    );
    const afterLink = await observations();
    assert.equal(afterLink.model.length, before.model.length);
    const ignoredReplay = await send(unlinked, true);
    assert.equal(ignoredReplay.status, 200);
    await ignoredReplay.body?.cancel();
    const eventId = "native-original-provider-event";
    const text = "Give one brief answer.";
    const input = eventPayload(eventId, text);
    const acknowledgements = await Promise.all([
      send(input),
      send(input, true),
    ]);
    assert.deepEqual(
      acknowledgements.map((response) => response.status),
      [200, 200]
    );
    await Promise.all(
      acknowledgements.map((response) => response.body?.cancel())
    );
    const after = await waitForFixture(
      observations,
      (value) =>
        value.model.length === before.model.length + 1 &&
        value.model.at(-1)?.completedAt !== undefined
    );
    const conversationId = await fixture.sql(
      "SELECT conversation_id FROM channel_conversation WHERE kind='slack' AND channel_id='D-native-queue' AND workspace_id='native-queue-workspace'"
    );
    assert.ok(conversationId && !conversationId.includes("\n"));
    const route = `/api/product/conversations/${encodeURIComponent(conversationId)}`;
    const snapshotSchema = z.object({
      snapshot: z
        .unknown()
        .transform((value) => Schema.decodeUnknownSync(ChatSnapshot)(value)),
    });
    const view = await waitForFixture(
      () => fixture.json(route, metadata.owner.cookie, snapshotSchema),
      (value) => !value.snapshot.busy
    );
    assert.deepEqual(
      view.snapshot.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      [text]
    );
    const operationId = `slack:${metadata.agent.organizationId}:${slack.appId}:${slack.workspaceId}:${eventId}`;
    const duplicate = await fixture.json(
      `${route}/messages`,
      metadata.owner.cookie,
      z.object({
        receipt: z
          .unknown()
          .transform((value) => Schema.decodeUnknownSync(ChatReceipt)(value)),
      }),
      { operationId, text }
    );
    assert.equal(duplicate.receipt.accepted, false);
    assert.equal(duplicate.receipt.operationId, operationId);
    const afterDuplicate = await observations();
    assert.equal(afterDuplicate.model.length, before.model.length + 1);
    await writeFile(
      path.join(path.dirname(metadataPath), "native-slack-queue-evidence.json"),
      `${JSON.stringify({ sourceIdentity: metadata.sourceIdentity, eventId, operationId, before, after, ignoredReceipt, conversationId, duplicate, snapshot: view.snapshot }, null, 2)}\n`
    );
  }
);
