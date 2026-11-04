import assert from "node:assert/strict";
import { before as beforeAll, test } from "node:test";

import { Schema } from "effect";
import { z } from "zod";

import {
  ChatReceipt,
  ChatSnapshot,
} from "../../../packages/contracts/src/session-service.ts";
import { TeamReportDeliverySchema } from "../../../packages/contracts/src/work.ts";
import { waitForFixture } from "../../slice-1/application.ts";
import {
  boot,
  completedCalls,
  controlReportQueue,
  queue,
  queueBodies,
  compose,
  drained,
  evidence,
  fixture,
  literal,
  metadata,
  observed,
  ready,
  summary,
  wireModels,
} from "./team-support.ts";

const publishedSchema = z.object({ agentId: z.string(), version: z.number() });
const conversationSchema = z.object({
  agentId: z.string(),
  conversationId: z.string(),
  sessionId: z.string(),
});
const viewSchema = conversationSchema.extend({
  snapshot: z
    .unknown()
    .transform((value) => Schema.decodeUnknownSync(ChatSnapshot)(value)),
});
const receiptSchema = z.object({
  receipt: z
    .unknown()
    .transform((value) => Schema.decodeUnknownSync(ChatReceipt)(value)),
});
let roles: {
  coordinator: z.infer<typeof publishedSchema>;
  lead: z.infer<typeof publishedSchema>;
  worker: z.infer<typeof publishedSchema>;
};

beforeAll(
  async () => {
    const published = await Promise.all(
      Object.keys(wireModels).map((role) =>
        fixture.json(
          "/api/product/agents",
          metadata.owner.cookie,
          publishedSchema,
          {
            operationId: crypto.randomUUID(),
            name: `Web ${role}`,
            model: `fixture/slack-${role}`,
            instructions: "Use the supplied bounded team tools.",
            enabledToolIds: [],
            grants: [],
          }
        )
      )
    );
    const [coordinator, lead, worker] = published;
    assert.ok(coordinator && lead && worker);
    roles = { coordinator, lead, worker };
    await compose(
      "run",
      "--no-deps",
      "--rm",
      "test-config",
      "node",
      "--input-type=module",
      "-e",
      "import {readFile,writeFile,rename} from 'node:fs/promises'; const p='/run/cerebro-secrets/'; const c=JSON.parse(await readFile(p+'runtime.json','utf8')); c.coordination=JSON.parse(process.argv[1]); await writeFile(p+'runtime.json.next',JSON.stringify(c),{mode:0o600}); await rename(p+'runtime.json.next',p+'runtime.json'); let channels={}; try { channels=JSON.parse(await readFile(p+'channels.json','utf8')); } catch(e) { if(e.code!=='ENOENT') throw e; } process.stdout.write(JSON.stringify({slackConfigured:Boolean(channels.slack)}));",
      JSON.stringify({
        leadAgentId: lead.agentId,
        workerAgentId: worker.agentId,
      })
    );
    await compose("run", "--no-deps", "--rm", "bootstrap");
    await compose("restart", "celld");
    await ready();
    await fixture.controls({
      arm: null,
      delayMs: 0,
      failFirst: false,
      models: {},
      release: true,
    });
  },
  { timeout: 180_000 }
);

const noSlack = async () => {
  const configuration = await compose(
    "run",
    "--no-deps",
    "--rm",
    "test-config",
    "node",
    "--input-type=module",
    "-e",
    "import {readFile} from 'node:fs/promises'; let c={}; try { c=JSON.parse(await readFile('/run/cerebro-secrets/channels.json','utf8')); } catch(e) { if(e.code!=='ENOENT') throw e; } process.stdout.write(JSON.stringify({slackConfigured:Boolean(c.slack)}));"
  );
  const counts = await fixture.sql(
    "SELECT json_build_object('links',(SELECT count(*) FROM identity_slack_link),'challenges',(SELECT count(*) FROM identity_slack_link_challenge),'slackConversations',(SELECT count(*) FROM channel_conversation WHERE kind='slack'),'slackAccounts',(SELECT count(*) FROM connector_account WHERE id ILIKE '%slack%' OR label ILIKE '%slack%'))"
  );
  const value = {
    ...z
      .object({ slackConfigured: z.boolean() })
      .parse(JSON.parse(configuration.stdout)),
    ...z
      .object({
        links: z.number(),
        challenges: z.number(),
        slackConversations: z.number(),
        slackAccounts: z.number(),
      })
      .parse(JSON.parse(counts)),
  };
  assert.deepEqual(value, {
    slackConfigured: false,
    links: 0,
    challenges: 0,
    slackConversations: 0,
    slackAccounts: 0,
  });
  return value;
};

test(
  "no-Slack web input starts private roles and imports one canonical result before the first product read",
  { timeout: 150_000 },
  async () => {
    await controlReportQueue("pause");
    try {
      const sourceConfiguration = await noSlack();
      const conversation = await fixture.json(
        "/api/product/conversations",
        metadata.owner.cookie,
        conversationSchema,
        {
          agentId: roles.coordinator.agentId,
          operationId: crypto.randomUUID(),
        }
      );
      const route = `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}`;
      const input = {
        operationId: crypto.randomUUID(),
        text: "SLACK_TEAM_FIXTURE run both worker checks.",
      };
      const before = await observed();
      const receipt = await fixture.json(
        `${route}/messages`,
        metadata.owner.cookie,
        receiptSchema,
        input
      );
      assert.equal(receipt.receipt.accepted, true);
      assert.equal(receipt.receipt.operationId, input.operationId);
      assert.ok(receipt.receipt.session);
      await fixture.json(
        `${route}/messages`,
        metadata.owner.cookie,
        receiptSchema,
        input
      );
      const completed = await waitForFixture(
        observed,
        (value) =>
          completedCalls(value, wireModels.coordinator).length ===
            completedCalls(before, wireModels.coordinator).length + 2 &&
          completedCalls(value, wireModels.lead).length ===
            completedCalls(before, wireModels.lead).length + 2 &&
          completedCalls(value, wireModels.worker).length ===
            completedCalls(before, wireModels.worker).length + 2,
        90_000
      );
      const externalCompletionAt = Date.now();
      const waiting = await waitForFixture(
        () => queue("peek", "cerebro-team-reports", 10),
        (value) =>
          queueBodies(value).some((body) => {
            const delivery = Schema.decodeUnknownSync(
              TeamReportDeliverySchema,
              { onExcessProperty: "error" }
            )(body);
            return (
              delivery.sourceEventAddress.conversationId ===
              conversation.conversationId
            );
          }),
        30_000
      );
      const queuedReport = queueBodies(waiting)
        .map((body) =>
          Schema.decodeUnknownSync(TeamReportDeliverySchema, {
            onExcessProperty: "error",
          })(body)
        )
        .find(
          (delivery) =>
            delivery.sourceEventAddress.conversationId ===
            conversation.conversationId
        );
      assert.ok(queuedReport && "version" in queuedReport);
      assert.equal(queuedReport.version, 2);
      assert.equal("sourceSlackThread" in queuedReport, false);
      await controlReportQueue("resume");
      const reportQueue = await drained("cerebro-team-reports");
      const firstConversationReadAt = Date.now();
      const view = await fixture.json(route, metadata.owner.cookie, viewSchema);
      assert.equal(view.agentId, roles.coordinator.agentId);
      assert.equal(view.conversationId, conversation.conversationId);
      assert.equal(view.sessionId, conversation.sessionId);
      assert.deepEqual(view.snapshot.address, {
        ...conversation,
        organizationId: metadata.agent.organizationId,
      });
      const starts = view.snapshot.tools.filter(
        (tool) => tool.toolName === "start_team"
      );
      assert.equal(starts.length, 1);
      assert.equal(starts[0]?.state, "succeeded");
      const startedWork = z
        .object({
          workId: z.string(),
          status: z.object({ kind: z.literal("accepted") }),
          deadlineAt: z.number(),
        })
        .parse(JSON.parse(starts[0]?.output ?? "null"));
      assert.equal(
        view.snapshot.messages.filter(
          (message) => message.role === "user" && message.text === input.text
        ).length,
        1
      );
      assert.equal(
        view.snapshot.messages.filter(
          (message) => message.role === "assistant" && message.text === summary
        ).length,
        1
      );
      const calls = completed.model.slice(before.model.length);
      const coordinatorTools = [
        "start_team",
        "get_work",
        "message_team",
        "stop_work",
      ];
      for (const call of calls) {
        assert.ok(
          call.completedAt !== undefined &&
            call.completedAt <= externalCompletionAt &&
            externalCompletionAt <= firstConversationReadAt
        );
        if (call.model === wireModels.coordinator) {
          assert.ok(
            coordinatorTools.every((name) => call.toolNames.includes(name))
          );
        } else {
          assert.ok(
            coordinatorTools.every((name) => !call.toolNames.includes(name))
          );
          assert.equal(
            call.toolNames.includes("delegate_worker"),
            call.model === wireModels.lead
          );
        }
      }
      assert.equal(completed.slack.calls.length, 0);
      const publicRoles = await fixture.sql(
        `SELECT count(*) FROM channel_conversation WHERE agent_id IN (${literal(roles.lead.agentId)},${literal(roles.worker.agentId)})`
      );
      assert.equal(publicRoles, "0");
      const source = await fixture.sql(
        `SELECT json_build_object('kind',kind,'organizationId',organization_id,'ownerPrincipalId',owner_principal_id,'agentId',agent_id,'conversationId',conversation_id,'sessionId',session_id,'workspaceId',workspace_id,'channelId',channel_id,'rootTimestamp',root_timestamp) FROM channel_conversation WHERE conversation_id=${literal(conversation.conversationId)}`
      );
      assert.deepEqual(JSON.parse(source), {
        kind: "web",
        organizationId: metadata.agent.organizationId,
        ownerPrincipalId: metadata.agent.principalId,
        ...conversation,
        workspaceId: null,
        channelId: null,
        rootTimestamp: null,
      });
      await fixture.json(
        `${route}/messages`,
        metadata.owner.cookie,
        receiptSchema,
        input
      );
      const replay = await observed();
      assert.equal(replay.model.length, completed.model.length);
      const reloaded = await fixture.json(
        route,
        metadata.owner.cookie,
        viewSchema
      );
      const repeated = await fixture.json(
        route,
        metadata.owner.cookie,
        viewSchema
      );
      assert.deepEqual(reloaded, view);
      assert.deepEqual(repeated, view);
      const retainedConfiguration = await noSlack();
      await evidence("web-team-native-complete", {
        boot: {
          fixtureId: boot.fixtureId,
          sha: boot.sha,
          apiUrl: boot.apiUrl,
          webUrl: boot.webUrl,
        },
        roles,
        conversation,
        input,
        sourceConfiguration,
        retainedConfiguration,
        publicRoles,
        startedWork,
        receipt,
        before,
        completed,
        externalCompletionAt,
        waiting,
        queuedReport,
        reportQueue,
        firstConversationReadAt,
        view,
        replay,
        reloaded,
        repeated,
      });
    } finally {
      await controlReportQueue("resume");
    }
  }
);
