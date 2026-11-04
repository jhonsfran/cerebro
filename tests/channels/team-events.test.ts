import { test } from "bun:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import { Schema } from "effect";

import { authenticateSessionRequest } from "../../apps/server/src/session/proof";
import { consumeTeamCommands } from "../../apps/server/src/team-events";
import {
  TeamCommandSchema,
  WorkAdmissionSchema,
  workCellName,
} from "../../packages/contracts/src/work";
import type { TeamCommand } from "../../packages/contracts/src/work";
import { identityPrincipal } from "../../packages/db/src/schema/identity";
import { createTestProduct, string } from "./helpers";

const secret = "private-team-gateway-test-value-with-32-characters";
const acceptedReceipt = (input: TeamCommand): Promise<Response> =>
  Promise.resolve(
    Response.json({
      kind: "accepted",
      commandId: input.id,
      key: input.work.key,
    })
  );
const setup = async () => {
  const app = await createTestProduct();
  const installed = await app.install();
  const ownerPrincipalId = string(installed.principalId);
  const databaseUrl = process.env.CHANNEL_TEST_DATABASE_URL;
  assert.ok(databaseUrl);
  const admittedAt = Date.now();
  const work = Schema.decodeUnknownSync(WorkAdmissionSchema)({
    admittedAt,
    deadlineAt: admittedAt + 60_000,
    goal: "Read the source.",
    contentDependencies: { sourceIds: [], toolIds: [] },
    key: {
      organizationId: app.options.organizationId,
      ownerPrincipalId,
      workId: "queue-team",
    },
    lead: { agentId: "lead", agentVersion: 1 },
    worker: { agentId: "worker", agentVersion: 2 },
    limits: { maxTeams: 2, maxWorkers: 2, maxTurns: 8, timeoutMs: 60_000 },
    sourceEventAddress: {
      organizationId: app.options.organizationId,
      agentId: "source",
      conversationId: "public",
      sessionId: "public",
    },
    sourceSlackThread: {
      workspaceId: "T",
      channelId: "D",
      rootTimestamp: "1800000000.000001",
    },
  });
  const configuration = JSON.stringify({
    mode: "local",
    gatewaySigningKey: secret,
    bootstrapToken: "private-bootstrap-test-value-with-32-characters",
    artifacts: {
      accessKeyId: "fixture",
      secretAccessKey: "fixture",
      bucket: "fixture",
      endpoint: "http://fixture:9000",
      region: "test",
    },
    models: [
      {
        id: "fixture/model",
        provider: "fixture",
        model: "model",
        apiKey: "fixture",
        baseUrl: "http://fixture:8090/v1",
        deadlineMs: 1000,
        maxInputBytes: 4096,
        maxOutputTokens: 128,
        maxResponseBytes: 4096,
      },
    ],
    retrievalMode: "full-text",
    tools: [],
  });
  const requests: Request[] = [];
  const targets: string[] = [];
  let result = acceptedReceipt;
  const env: Parameters<typeof consumeTeamCommands>[1] = {
    DATABASE_URL: databaseUrl,
    DEPLOY_MODE: "local",
    RUNTIME_CONFIG_JSON: configuration,
    TEAM: {
      idFromName: (name) => ({
        name,
        toString: () => name,
        equals: (other) => other.name === name,
      }),
      get: (target) => ({
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request.clone());
          targets.push(target.name ?? "");
          const parsed = Schema.decodeUnknownSync(TeamCommandSchema)(
            await request.clone().json()
          );
          const verified = await authenticateSessionRequest(request, secret, {
            organizationId: work.key.organizationId,
            ownerPrincipalId,
          });
          assert.deepEqual(verified.address, work.sourceEventAddress);
          assert.equal(verified.context.actor.id, ownerPrincipalId);
          return await result(parsed);
        },
      }),
    },
  };
  return {
    app,
    work,
    env,
    requests,
    targets,
    respond: (next: typeof result) => {
      result = next;
    },
  };
};
const delivery = (body: unknown, attempts = 1) => {
  const decisions: { acknowledged: number; retries: number[] } = {
    acknowledged: 0,
    retries: [],
  };
  const batch: MessageBatch<unknown> = {
    queue: "cerebro-team-commands",
    metadata: { metrics: { backlogBytes: 1, backlogCount: 1 } },
    messages: [
      {
        id: "message-id",
        timestamp: new Date(),
        body,
        attempts,
        ack: () => {
          decisions.acknowledged += 1;
        },
        retry: (options) => {
          decisions.retries.push(options?.delaySeconds ?? 0);
        },
      },
    ],
    ackAll: () => {
      throw new Error("Expected per-message acknowledgement.");
    },
    retryAll: () => {
      throw new Error("Expected per-message retry.");
    },
  };
  return { batch, decisions };
};

test("the real team consumer authenticates the exact work target and waits for its durable receipt", async () => {
  const fixture = await setup();
  const entered = Promise.withResolvers<boolean>();
  const committed = Promise.withResolvers<Response>();
  fixture.respond(() => {
    entered.resolve(true);
    return committed.promise;
  });
  const input: TeamCommand = {
    kind: "start",
    id: "start-team",
    work: fixture.work,
  };
  const first = delivery(input);
  const consume = consumeTeamCommands(first.batch, fixture.env);
  await entered.promise;
  assert.equal(first.decisions.acknowledged, 0);
  assert.deepEqual(first.decisions.retries, []);
  committed.resolve(
    Response.json({
      kind: "accepted",
      commandId: input.id,
      key: fixture.work.key,
    })
  );
  await consume;
  assert.equal(first.decisions.acknowledged, 1);
  assert.deepEqual(fixture.targets, [workCellName(fixture.work.key)]);
  const [request] = fixture.requests;
  assert.ok(request);
  const body = await request.clone().text();
  assert.deepEqual(JSON.parse(body), input);
  assert.equal(body.includes("actor"), false);
  assert.equal(body.includes(secret), false);
  const changed = new Request(request, {
    method: "POST",
    body: JSON.stringify({ ...input, id: "changed-command" }),
  });
  await assert.rejects(
    authenticateSessionRequest(changed, secret, {
      organizationId: fixture.work.key.organizationId,
      ownerPrincipalId: fixture.work.key.ownerPrincipalId,
    })
  );
});

test("a failed or mismatched team receipt retries with bounded delay, while terminal rejection acknowledges", async () => {
  const fixture = await setup();
  const input: TeamCommand = {
    kind: "start",
    id: "start-team",
    work: fixture.work,
  };
  fixture.respond(() => Promise.resolve(new Response(null, { status: 503 })));
  const unavailable = delivery(input, 12);
  await consumeTeamCommands(unavailable.batch, fixture.env);
  assert.deepEqual(unavailable.decisions, { acknowledged: 0, retries: [60] });
  fixture.respond(() =>
    Promise.resolve(
      Response.json({
        kind: "accepted",
        commandId: "wrong-command",
        key: fixture.work.key,
      })
    )
  );
  const wrong = delivery(input);
  await consumeTeamCommands(wrong.batch, fixture.env);
  assert.equal(wrong.decisions.acknowledged, 0);
  fixture.respond(() =>
    Promise.resolve(
      Response.json({
        kind: "rejected",
        commandId: input.id,
        key: fixture.work.key,
        reason: "cancelled",
      })
    )
  );
  const ignored = delivery(input);
  await consumeTeamCommands(ignored.batch, fixture.env);
  assert.deepEqual(ignored.decisions, { acknowledged: 1, retries: [] });
});

test("poison, oversized UTF-8, and disabled-principal commands never reach a private team", async () => {
  const fixture = await setup();
  const input: TeamCommand = {
    kind: "start",
    id: "start-team",
    work: fixture.work,
  };
  const poison = delivery({ ...input, botToken: "never-queue-a-credential" });
  await consumeTeamCommands(poison.batch, fixture.env);
  const oversized = delivery({
    ...input,
    work: {
      ...fixture.work,
      contentDependencies: {
        sourceIds: Array.from(
          { length: 140 },
          (_, index) => `${"é".repeat(500)}${index}`
        ),
        toolIds: [],
      },
    },
  });
  await consumeTeamCommands(oversized.batch, fixture.env);
  await fixture.app.options.withDatabase((db) =>
    db
      .update(identityPrincipal)
      .set({ state: "disabled" })
      .where(eq(identityPrincipal.id, fixture.work.key.ownerPrincipalId))
  );
  const disabled = delivery(input);
  await consumeTeamCommands(disabled.batch, fixture.env);
  assert.equal(fixture.requests.length, 0);
  assert.equal(poison.decisions.acknowledged, 0);
  assert.equal(oversized.decisions.acknowledged, 0);
  assert.equal(disabled.decisions.acknowledged, 0);
  assert.deepEqual(
    [
      poison.decisions.retries.length,
      oversized.decisions.retries.length,
      disabled.decisions.retries.length,
    ],
    [1, 1, 1]
  );
});
