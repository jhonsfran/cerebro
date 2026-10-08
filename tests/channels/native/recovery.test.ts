import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { Schema } from "effect";
import { z } from "zod";

import { DomainSnapshot } from "../../../packages/contracts/src/session-service.ts";
import {
  applicationFixture,
  readApplicationBoot,
  waitForFixture,
} from "../../slice-1/application.ts";

const execute = promisify(execFile);
const metadataPath = process.env.CHANNEL_NATIVE_METADATA;
if (!metadataPath) {
  throw new Error(
    "Run tests/channels/native/run.mjs to boot a fresh owned application."
  );
}
const metadata = z
  .object({
    agent: z.object({
      agentId: z.string(),
      organizationId: z.string(),
      principalId: z.string(),
      version: z.number(),
    }),
    bootPath: z.string(),
    owner: z.object({ cookie: z.string(), userId: z.string() }),
    sourceCheckoutDirty: z.boolean(),
    sourceIdentity: z.string(),
  })
  .parse(JSON.parse(await readFile(metadataPath, "utf-8")));
const boot = await readApplicationBoot(metadata.bootPath);
const fixture = applicationFixture(boot);
const directory = path.dirname(metadataPath);
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const providerSchema = z.object({
  checkpoints: z.array(
    z.object({
      armId: z.string().nullable().optional(),
      armed: z.boolean().optional(),
      at: z.number(),
      boundary: z.string(),
      operationId: z.string(),
    })
  ),
  model: z.array(
    z.object({
      completedAt: z.number().optional(),
      operationId: z.string(),
      startedAt: z.number(),
      status: z.number().optional(),
    })
  ),
  tools: z.array(z.object({ operationId: z.string(), write: z.boolean() })),
});
const provider = async () => providerSchema.parse(await fixture.observations());
const inboxSchema = z.object({
  digest: z.string(),
  envelope: z.object({ eventId: z.string() }).passthrough(),
  eventKey: z.string(),
  receipt: z.unknown().nullable(),
  state: z.string(),
  submissionMode: z.string(),
});
const inbox = async (conversationId: string) =>
  inboxSchema.parse(
    JSON.parse(
      await fixture.sql(
        `SELECT json_build_object('digest',digest,'envelope',envelope,'eventKey',event_key,'receipt',receipt,'state',state,'submissionMode',submission_mode) FROM channel_inbox WHERE conversation_id=${literal(conversationId)}`
      )
    )
  );

test(
  "actual channel dispatcher recovers persisted pending admission after SIGKILL without an engine HTTP request within 60 seconds",
  { timeout: 180_000 },
  async () => {
    const saved: Record<string, unknown> = {};
    let client:
      | Promise<{ status?: number; body?: unknown; error?: string }>
      | undefined;
    try {
      const { agent, owner } = metadata;
      const conversation = await fixture.json(
        "/api/product/conversations",
        owner.cookie,
        z.object({ conversationId: z.string(), sessionId: z.string() }),
        { agentId: agent.agentId, operationId: randomUUID() }
      );
      const route = `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}`;
      const initial = await provider();
      const armId = `channel-pending:${randomUUID()}`;
      await fixture.controls({
        arm: { boundary: "before-admission", id: armId },
        delayMs: 100,
        failFirst: false,
      });
      const message = {
        eventId: randomUUID(),
        mode: "follow-up",
        text: "What is the refund policy?",
      };
      client = (async () => {
        try {
          const response = await fixture.request(
            `${route}/messages`,
            owner.cookie,
            message
          );
          return { body: await response.json(), status: response.status };
        } catch (error) {
          return { error: String(error) };
        }
      })();
      const held = await waitForFixture(
        provider,
        (value) =>
          value.checkpoints.some(
            (entry) =>
              entry.boundary === "before-admission" &&
              entry.armId === armId &&
              entry.armed === true
          ),
        30_000
      );
      const pending = await inbox(conversation.conversationId);
      assert.equal(pending.state, "pending");
      assert.equal(pending.receipt, null);
      assert.equal(pending.submissionMode, "follow-up");
      assert.equal(held.model.length, initial.model.length);
      assert.deepEqual(held.tools, initial.tools);
      assert.ok(
        held.checkpoints.some(
          (entry) =>
            entry.operationId === pending.envelope.eventId &&
            entry.armId === armId
        )
      );
      const containerId = await fixture.container("celld");
      saved.before = { containerId, held, initial, pending };
      await execute("rtk", [
        "proxy",
        "docker",
        "kill",
        "--signal",
        "SIGKILL",
        containerId,
      ]);
      const interrupted = await client;
      assert.ok(
        interrupted.error ||
          (interrupted.status !== undefined && interrupted.status >= 500),
        "Admission was not acknowledged before the killed checkpoint"
      );
      await fixture.controls({ arm: null, release: true });
      const restartStartedAt = Date.now();
      await execute("rtk", ["proxy", "docker", "start", containerId]);
      // During this interval only the independent provider and PostgreSQL are read.
      const recoveredProvider = await waitForFixture(
        provider,
        (value) =>
          value.model.length === initial.model.length + 1 &&
          value.model.at(-1)?.completedAt !== undefined &&
          value.model.at(-1)?.status === 200,
        60_000
      );
      const providerCompletedAt = Date.now();
      assert.ok(
        providerCompletedAt - restartStartedAt <= 60_000,
        "Pending ingress recovery must complete before the unchanged 60 s gate"
      );
      assert.deepEqual(recoveredProvider.tools, initial.tools);
      const recoveredInbox = await waitForFixture(
        () => inbox(conversation.conversationId),
        (value) => value.state === "accepted",
        10_000
      );
      assert.equal(recoveredInbox.digest, pending.digest);
      assert.deepEqual(recoveredInbox.envelope, pending.envelope);
      assert.equal(recoveredInbox.eventKey, pending.eventKey);
      assert.equal(recoveredInbox.submissionMode, pending.submissionMode);
      const receipt = z
        .object({
          acceptedEventId: z.string(),
          replayed: z.boolean(),
          runId: z.string(),
          sessionId: z.string(),
        })
        .parse(recoveredInbox.receipt);
      assert.equal(receipt.acceptedEventId, pending.envelope.eventId);
      assert.equal(receipt.sessionId, conversation.sessionId);
      assert.equal(recoveredProvider.model.at(-1)?.operationId, receipt.runId);
      const projected = await waitForFixture(
        async () =>
          JSON.parse(
            await fixture.sql(
              `SELECT json_build_object('outputs',(SELECT count(*) FROM channel_item WHERE conversation_id=c.conversation_id AND item->>'type'='output'),'projectionState',projection_state,'runs',(SELECT json_agg(item->'run') FROM channel_item WHERE conversation_id=c.conversation_id AND item->>'type'='run'),'users',(SELECT count(*) FROM channel_item WHERE conversation_id=c.conversation_id AND item->>'type'='user')) FROM channel_conversation c WHERE conversation_id=${literal(conversation.conversationId)}`
            )
          ),
        (value) =>
          z
            .object({ outputs: z.number(), projectionState: z.string() })
            .parse(value).outputs === 1 &&
          z.object({ projectionState: z.string() }).parse(value)
            .projectionState === "idle",
        10_000
      );
      const projection = z
        .object({
          outputs: z.literal(1),
          projectionState: z.literal("idle"),
          runs: z.array(
            z.object({ runId: z.string(), state: z.literal("completed") })
          ),
          users: z.literal(1),
        })
        .parse(projected);
      assert.equal(projection.runs.length, 1);
      assert.equal(projection.runs[0].runId, receipt.runId);
      const view = await fixture.json(
        route,
        owner.cookie,
        z.object({
          snapshot: z
            .unknown()
            .transform((value) =>
              Schema.decodeUnknownSync(DomainSnapshot)(value)
            ),
        })
      );
      assert.equal(view.snapshot.runs.length, 1);
      assert.equal(view.snapshot.runs[0].state, "completed");
      assert.equal(view.snapshot.outputs.length, 1);
      const replay = await fixture.json(
        `${route}/messages`,
        owner.cookie,
        z.object({
          receipt: z.object({ replayed: z.literal(true), runId: z.string() }),
        }),
        message
      );
      assert.equal(replay.receipt.runId, receipt.runId);
      const final = await provider();
      assert.deepEqual(final.model, recoveredProvider.model);
      assert.deepEqual(final.tools, initial.tools);
      saved.after = {
        elapsedMs: providerCompletedAt - restartStartedAt,
        final,
        interrupted,
        projection,
        providerCompletedAt,
        receipt,
        recoveredInbox,
        recoveredProvider,
        replay,
        restartStartedAt,
        view,
      };
    } finally {
      await client;
      await writeFile(
        path.join(directory, "channel-recovery.json"),
        `${JSON.stringify({ boot, saved, sourceCheckoutDirty: metadata.sourceCheckoutDirty, sourceIdentity: metadata.sourceIdentity }, null, 2)}\n`
      );
    }
  }
);
