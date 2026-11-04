import { test } from "bun:test";
import assert from "node:assert/strict";

import { Schema } from "effect";

import { authenticateSessionRequest } from "../../apps/server/src/session/proof";
import { consumeTeamReports } from "../../apps/server/src/team-reports";
import { assertQueuePayloadSize } from "../../packages/channels/src/queue-payload";
import { prepareTeamReport } from "../../packages/channels/src/team-reports";
import {
  TeamReportDeliverySchema,
  WorkAdmissionSchema,
  WorkReportSchema,
} from "../../packages/contracts/src/work";
import { createTestProduct, string } from "./helpers";

const work = (organizationId: string, ownerPrincipalId: string) =>
  Schema.decodeUnknownSync(WorkAdmissionSchema)({
    admittedAt: 1000,
    deadlineAt: 61_000,
    goal: "Read.",
    key: { organizationId, ownerPrincipalId, workId: "report-work" },
    lead: { agentId: "lead", agentVersion: 1 },
    worker: { agentId: "worker", agentVersion: 1 },
    limits: { maxTeams: 2, maxWorkers: 2, maxTurns: 8, timeoutMs: 60_000 },
    sourceEventAddress: {
      organizationId,
      agentId: "source",
      conversationId: "source",
      sessionId: "source",
    },
    sourceSlackThread: {
      workspaceId: "T",
      channelId: "D",
      rootTimestamp: "1800000000.000001",
    },
    contentDependencies: { sourceIds: [], toolIds: [] },
  });
test("valid reports with oversized UTF-8 provenance get a stable constant transfer without altering private evidence", () => {
  const admission = work("org", "owner");
  const report = Schema.decodeUnknownSync(WorkReportSchema)({
    id: "report:report-work",
    key: admission.key,
    kind: "completed",
    text: "PRIVATE_DERIVED_RESULT",
    contentDependencies: {
      sourceIds: Array.from(
        { length: 140 },
        (_, index) => `${"é".repeat(500)}${index}`
      ),
      toolIds: [],
    },
  });
  assert.throws(() =>
    assertQueuePayloadSize({
      report,
      sourceEventAddress: admission.sourceEventAddress,
      sourceSlackThread: admission.sourceSlackThread,
    })
  );
  const transfer = prepareTeamReport(admission, report);
  assert.equal(transfer.report.kind, "failed");
  assert.deepEqual(transfer.report.contentDependencies, {
    sourceIds: [],
    toolIds: [],
  });
  assert.equal(
    JSON.stringify(transfer).includes("PRIVATE_DERIVED_RESULT"),
    false
  );
  assert.equal(report.contentDependencies.sourceIds.length, 140);
  assert.deepEqual(prepareTeamReport(admission, report), transfer);
  assertQueuePayloadSize(transfer);
  const cancelled = prepareTeamReport(admission, {
    id: report.id,
    key: report.key,
    kind: "cancelled",
    contentDependencies: report.contentDependencies,
  });
  assert.equal(cancelled.report.kind, "cancelled");
});

test("the report consumer authenticates the original source and ACKs only after its durable notification receipt", async () => {
  const app = await createTestProduct();
  const installed = await app.install();
  const admission = work(
    app.options.organizationId,
    string(installed.principalId)
  );
  const delivery = prepareTeamReport(admission, {
    id: "report:report-work",
    key: admission.key,
    kind: "completed",
    text: "Result.",
    contentDependencies: { sourceIds: [], toolIds: [] },
  });
  const databaseUrl = process.env.CHANNEL_TEST_DATABASE_URL;
  assert.ok(databaseUrl);
  const secret = "private-report-gateway-value-with-32-characters";
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  let calls = 0;
  let acknowledged = 0;
  const retries: number[] = [];
  let fail = false;
  const env: Parameters<typeof consumeTeamReports>[1] = {
    DATABASE_URL: databaseUrl,
    DEPLOY_MODE: "local",
    RUNTIME_CONFIG_JSON: JSON.stringify({
      mode: "local",
      gatewaySigningKey: secret,
      bootstrapToken: secret,
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
    }),
    SESSION: {
      idFromName: (name) => ({
        name,
        toString: () => name,
        equals: (other) => other.name === name,
      }),
      get: (target) => ({
        fetch: async (input, init) => {
          calls += 1;
          assert.equal(
            target.name,
            JSON.stringify([
              admission.key.organizationId,
              admission.key.ownerPrincipalId,
            ])
          );
          const request = new Request(input, init);
          const verified = await authenticateSessionRequest(request, secret, {
            organizationId: admission.key.organizationId,
            ownerPrincipalId: admission.key.ownerPrincipalId,
          });
          assert.deepEqual(verified.address, admission.sourceEventAddress);
          assert.deepEqual(
            Schema.decodeUnknownSync(TeamReportDeliverySchema)(
              await request.clone().json()
            ),
            delivery
          );
          entered.resolve(true);
          await release.promise;
          return fail
            ? new Response(null, { status: 503 })
            : Response.json({
                reportId: delivery.report.id,
                key: delivery.report.key,
                accepted: true,
              });
        },
      }),
    },
  };
  const batch: MessageBatch<unknown> = {
    queue: "cerebro-team-reports",
    metadata: { metrics: { backlogBytes: 1, backlogCount: 1 } },
    messages: [
      {
        id: "queue-report",
        timestamp: new Date(),
        body: delivery,
        attempts: 1,
        ack: () => {
          acknowledged += 1;
        },
        retry: (options) => {
          retries.push(options?.delaySeconds ?? 0);
        },
      },
    ],
    ackAll: () => {
      throw new Error("Expected per-message ACK.");
    },
    retryAll: () => {
      throw new Error("Expected per-message retry.");
    },
  };
  const consuming = consumeTeamReports(batch, env);
  await entered.promise;
  assert.equal(acknowledged, 0);
  release.resolve(true);
  await consuming;
  assert.equal(acknowledged, 1);
  fail = true;
  await consumeTeamReports(batch, env);
  assert.equal(acknowledged, 1);
  assert.deepEqual(retries, [2]);
  const poison = {
    ...batch,
    messages: batch.messages.map((message) => ({
      ...message,
      body: { ...delivery, token: secret },
    })),
  };
  await consumeTeamReports(poison, env);
  assert.equal(calls, 2);
  assert.equal(acknowledged, 1);
});
