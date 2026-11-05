import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { z } from "zod";

import { createSlackApi } from "../../packages/channels/src/slack-api.ts";
import { createFixture } from "../slice-1/provider.mjs";

const observationSchema = z.object({
  controls: z.object({
    slackPostUnknown: z
      .object({
        channel: z.string(),
        threadTs: z.string().nullable(),
        textSha256: z.string(),
        consumedAt: z.number().nullable(),
      })
      .nullable()
      .optional(),
  }),
  model: z.array(z.object({ status: z.number().optional() })),
  slack: z.object({
    calls: z.array(
      z.object({
        method: z.string(),
        request: z.record(z.string(), z.unknown()),
        response: z.record(z.string(), z.unknown()),
        status: z.number().optional(),
      })
    ),
    messages: z.array(
      z.object({
        blocks: z.array(z.unknown()),
        channel: z.string(),
        kind: z.enum(["ephemeral", "message"]),
        text: z.string(),
        ts: z.string(),
        threadTs: z.string().optional(),
        user: z.string().optional(),
      })
    ),
    nextTimestamp: z.number(),
  }),
  tools: z.array(z.unknown()),
});

const openFixture = async (directory: string) => {
  const fixture = await createFixture({
    directory,
    fixtureId: "slack-fixture-test",
    sha: "slack-fixture-test-source",
  });
  fixture.server.listen(0, "127.0.0.1");
  await once(fixture.server, "listening");
  const address = fixture.server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const api = createSlackApi({
    agentId: "fixture-agent",
    apiUrl: `${baseUrl}/slack`,
    appId: "fixture-app",
    botToken: "fixture-slack-token",
    signingSecret: "fixture-signing-secret",
    workspaceId: "fixture-workspace",
  });
  return {
    api,
    baseUrl,
    control: async (input: unknown) => {
      const response = await fetch(`${baseUrl}/control`, {
        body: JSON.stringify(input),
        headers: {
          "Content-Type": "application/json",
          "X-Fixture-Control": "slice-1-control",
        },
        method: "POST",
      });
      await response.body?.cancel();
      return response.status;
    },
    close: async () => {
      if (fixture.server.listening) {
        const closed = once(fixture.server, "close");
        fixture.server.close();
        fixture.server.closeAllConnections();
        await closed;
      }
      await fixture.flush();
    },
    observed: async () => {
      const response = await fetch(`${baseUrl}/observations`);
      assert.equal(response.status, 200);
      return observationSchema.parse(await response.json());
    },
    persisted: async () =>
      observationSchema.parse(
        JSON.parse(
          await readFile(path.join(directory, "committed.json"), "utf-8")
        )
      ),
  };
};

test(
  "the real Slack adapter posts and edits a thread reply, with durable observations across fixture restart",
  { timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cerebro-slack-fixture-")
    );
    let fixture = await openFixture(directory);
    try {
      const posted = await fixture.api.send({
        channel: "D-team",
        text: "Team is running.",
        threadTs: "1700000000.000001",
        blocks: [{ type: "divider" }],
      });
      assert.deepEqual(posted, { state: "sent", ts: "1800000000.000000" });
      assert.deepEqual(
        await fixture.api.edit({
          channel: "D-team",
          text: "Team result is ready.",
          ts: "1800000000.000000",
        }),
        { state: "sent", ts: "1800000000.000000" }
      );
      assert.deepEqual(
        await fixture.api.sendEphemeral({
          channel: "D-team",
          text: "Only you can see this.",
          user: "U-owner",
        }),
        { state: "sent", ts: "" }
      );
      const observed = await fixture.observed();
      const persisted = await fixture.persisted();
      assert.deepEqual(observed.slack, persisted.slack);
      assert.deepEqual(observed.slack.messages, [
        {
          blocks: [],
          channel: "D-team",
          kind: "message",
          text: "Team result is ready.",
          ts: "1800000000.000000",
          threadTs: "1700000000.000001",
        },
        {
          blocks: [],
          channel: "D-team",
          kind: "ephemeral",
          text: "Only you can see this.",
          ts: "1800000000.000001",
          user: "U-owner",
        },
      ]);
      assert.deepEqual(
        observed.slack.calls.map((call) => ({
          method: call.method,
          request: call.request,
        })),
        [
          {
            method: "chat.postMessage",
            request: {
              blocks: [{ type: "divider" }],
              channel: "D-team",
              text: "Team is running.",
              thread_ts: "1700000000.000001",
            },
          },
          {
            method: "chat.update",
            request: {
              blocks: [],
              channel: "D-team",
              text: "Team result is ready.",
              ts: "1800000000.000000",
            },
          },
          {
            method: "chat.postEphemeral",
            request: {
              channel: "D-team",
              text: "Only you can see this.",
              user: "U-owner",
            },
          },
        ]
      );
      assert.deepEqual(observed.slack.calls.at(2)?.response, {
        message_ts: "1800000000.000001",
        ok: true,
      });
      await fixture.close();
      fixture = await openFixture(directory);
      const restored = await fixture.observed();
      assert.deepEqual(restored.slack, observed.slack);
      assert.deepEqual(
        await fixture.api.send({
          channel: "D-team",
          text: "Team result is ready.",
        }),
        { state: "sent", ts: "1800000000.000002" }
      );
      const afterRestart = await fixture.observed();
      assert.equal(afterRestart.slack.calls.length, 4);
      assert.equal(afterRestart.slack.messages.length, 3);
      assert.equal(
        afterRestart.slack.messages.at(-1)?.text,
        "Team result is ready."
      );
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  "an exact one-shot Slack post is accepted before 503 and stays consumed after reopen",
  { timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cerebro-slack-unknown-")
    );
    let fixture = await openFixture(directory);
    try {
      const destination = {
        channel: "D-unknown",
        threadTs: "1700000000.000042",
      };
      const text = "The Slack admission recommendation is ready.";
      const selector = {
        ...destination,
        textSha256: createHash("sha256").update(text).digest("hex"),
      };
      assert.equal(await fixture.control({ slackPostUnknown: selector }), 200);
      const send = { ...destination, text };
      assert.deepEqual(await fixture.api.send(send), { state: "unknown" });
      const accepted = await fixture.persisted();
      assert.equal(accepted.slack.calls.length, 1);
      assert.deepEqual(accepted.slack.calls[0], {
        method: "chat.postMessage",
        request: { channel: "D-unknown", text, thread_ts: "1700000000.000042" },
        response: { error: "fatal_error", ok: false },
        status: 503,
      });
      assert.deepEqual(accepted.slack.messages, [
        {
          blocks: [],
          ...destination,
          kind: "message",
          text,
          ts: "1800000000.000000",
        },
      ]);
      assert.equal(accepted.slack.nextTimestamp, 1_800_000_000_000_001);
      assert.ok(accepted.controls.slackPostUnknown?.consumedAt);
      assert.deepEqual(await fixture.observed(), accepted);
      await fixture.close();
      fixture = await openFixture(directory);
      const restored = await fixture.persisted();
      assert.deepEqual(restored.controls, accepted.controls);
      assert.deepEqual(
        await fixture.api.send({
          ...destination,
          text: "A distinct event can receive a reply.",
        }),
        { state: "sent", ts: "1800000000.000001" }
      );
      assert.deepEqual(await fixture.api.send(send), {
        state: "sent",
        ts: "1800000000.000002",
      });
      const reopened = await fixture.persisted();
      assert.deepEqual(
        reopened.slack.calls.map((call) => call.status),
        [503, 200, 200]
      );
      assert.deepEqual(
        reopened.slack.messages.map((message) => ({
          text: message.text,
          ts: message.ts,
        })),
        [
          { text, ts: "1800000000.000000" },
          {
            text: "A distinct event can receive a reply.",
            ts: "1800000000.000001",
          },
          { text, ts: "1800000000.000002" },
        ]
      );
      assert.deepEqual(reopened.controls, accepted.controls);
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  "the unknown selector matches the method, channel, original thread, and exact text digest",
  { timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cerebro-slack-selector-")
    );
    const fixture = await openFixture(directory);
    try {
      const send = {
        channel: "D-exact",
        threadTs: "1700000000.000043",
        text: "Exact reply.",
      };
      const selector = {
        channel: send.channel,
        threadTs: send.threadTs,
        textSha256: createHash("sha256").update(send.text).digest("hex"),
      };
      assert.equal(
        await fixture.control({
          slackPostUnknown: { ...selector, consumedAt: 1 },
        }),
        400
      );
      assert.equal(
        await fixture.control({
          slackPostUnknown: { ...selector, textSha256: "invalid" },
        }),
        400
      );
      assert.equal(await fixture.control({ slackPostUnknown: selector }), 200);
      assert.deepEqual(
        await fixture.api.send({ ...send, channel: "D-other" }),
        { state: "sent", ts: "1800000000.000000" }
      );
      assert.deepEqual(
        await fixture.api.send({ ...send, threadTs: "1700000000.000044" }),
        { state: "sent", ts: "1800000000.000001" }
      );
      assert.deepEqual(
        await fixture.api.send({ ...send, text: "Exact reply. " }),
        { state: "sent", ts: "1800000000.000002" }
      );
      assert.deepEqual(
        await fixture.api.sendEphemeral({ ...send, user: "U-owner" }),
        { state: "sent", ts: "" }
      );
      assert.deepEqual(
        await fixture.api.edit({ ...send, ts: "1800000000.000002" }),
        { state: "sent", ts: "1800000000.000002" }
      );
      const before = await fixture.persisted();
      assert.equal(before.controls.slackPostUnknown?.consumedAt, null);
      assert.deepEqual(
        before.slack.calls.map((call) => call.status),
        [200, 200, 200, 200, 200]
      );
      assert.deepEqual(await fixture.api.send(send), { state: "unknown" });
      const after = await fixture.persisted();
      assert.equal(after.slack.calls.length, 6);
      assert.equal(after.slack.messages.length, 5);
      assert.equal(after.slack.messages.at(-1)?.ts, "1800000000.000004");
      assert.ok(after.controls.slackPostUnknown?.consumedAt);
      assert.equal(await fixture.control({ slackPostUnknown: null }), 200);
      const cleared = await fixture.persisted();
      assert.equal(cleared.controls.slackPostUnknown, null);
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  "Slack rejects invalid edits and credentials while the ordinary model fixture still responds",
  { timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cerebro-slack-errors-")
    );
    const fixture = await openFixture(directory);
    try {
      await fixture.api.sendEphemeral({
        channel: "D-team",
        text: "Private notice.",
        user: "U-owner",
      });
      assert.deepEqual(
        await fixture.api.edit({
          channel: "D-team",
          text: "Cannot replace an ephemeral message.",
          ts: "1800000000.000000",
        }),
        { error: "cant_update_message", state: "failed" }
      );
      assert.deepEqual(
        await fixture.api.edit({
          channel: "D-other",
          text: "Cannot edit another channel.",
          ts: "1800000000.000000",
        }),
        { error: "message_not_found", state: "failed" }
      );
      const denied = await fetch(`${fixture.baseUrl}/slack/chat.postMessage`, {
        body: JSON.stringify({ channel: "D-team", text: "Do not save this." }),
        headers: {
          Authorization: "Bearer wrong-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      assert.deepEqual(await denied.json(), {
        error: "invalid_auth",
        ok: false,
      });
      const controls = await fetch(`${fixture.baseUrl}/control`, {
        body: JSON.stringify({ delayMs: 0 }),
        headers: {
          "Content-Type": "application/json",
          "X-Fixture-Control": "slice-1-control",
        },
        method: "POST",
      });
      assert.equal(controls.status, 200);
      await controls.body?.cancel();
      const model = await fetch(`${fixture.baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ role: "user", content: "Answer normally." }],
          model: "slice-1",
        }),
        headers: {
          Authorization: "Bearer fixture-model-key",
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      assert.equal(model.status, 200);
      const output = z
        .object({ choices: z.array(z.object({ message: z.unknown() })) })
        .parse(await model.json());
      assert.deepEqual(output.choices.at(0)?.message, {
        content: "Cerebro slice 1 completed.",
        role: "assistant",
      });
      const observed = await fixture.observed();
      assert.deepEqual(observed.slack.messages, [
        {
          blocks: [],
          channel: "D-team",
          kind: "ephemeral",
          text: "Private notice.",
          ts: "1800000000.000000",
          user: "U-owner",
        },
      ]);
      assert.equal(observed.slack.calls.length, 3);
      assert.equal(observed.model.at(0)?.status, 200);
      assert.equal(observed.tools.length, 0);
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
