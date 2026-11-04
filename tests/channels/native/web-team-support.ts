/* oxlint-disable no-await-in-loop -- Native frame reads, controls, and crash checkpoints require ordered effects. */
import assert from "node:assert/strict";

import { Schema } from "effect";
import { z } from "zod";

import {
  ChatReceipt,
  ChatSnapshot,
  ChatObservation,
  ChatControlReceipt,
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
  fixture,
  metadata,
  observed,
  ready,
  wireModels,
} from "./team-support.ts";

export const publishedSchema = z.object({
  agentId: z.string(),
  version: z.number(),
});
export const conversationSchema = z.object({
  agentId: z.string(),
  conversationId: z.string(),
  sessionId: z.string(),
});
export const viewSchema = conversationSchema.extend({
  snapshot: z
    .unknown()
    .transform((value) => Schema.decodeUnknownSync(ChatSnapshot)(value)),
});
export const receiptSchema = z.object({
  receipt: z
    .unknown()
    .transform((value) => Schema.decodeUnknownSync(ChatReceipt)(value)),
});
export const controlSchema = z
  .unknown()
  .transform((value) => Schema.decodeUnknownSync(ChatControlReceipt)(value));
export const marker = "SLACK_TEAM_FIXTURE run both worker checks.";
export const coordinatorTools = [
  "start_team",
  "get_work",
  "message_team",
  "stop_work",
];
let publishedRoles:
  | {
      coordinator: z.infer<typeof publishedSchema>;
      lead: z.infer<typeof publishedSchema>;
      worker: z.infer<typeof publishedSchema>;
    }
  | undefined;
export const roles = () => {
  assert.ok(
    publishedRoles,
    "Publish fixture roles before using the web team helper."
  );
  return publishedRoles;
};

export const noSlack = async () => {
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

export const setupWebTeam = async () => {
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
  publishedRoles = { coordinator, lead, worker };
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
  await noSlack();
};

export const createConversation = async () => {
  const conversation = await fixture.json(
    "/api/product/conversations",
    metadata.owner.cookie,
    conversationSchema,
    {
      agentId: roles().coordinator.agentId,
      operationId: crypto.randomUUID(),
    }
  );
  return {
    conversation,
    route: `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}`,
  };
};
export const read = (route: string) =>
  fixture.json(route, metadata.owner.cookie, viewSchema);
export const sendMessage = (
  route: string,
  input: { operationId: string; text: string }
) =>
  fixture.json(
    `${route}/messages`,
    metadata.owner.cookie,
    receiptSchema,
    input
  );
export const stopWork = (
  route: string,
  workId: string,
  operationId = crypto.randomUUID()
) =>
  fixture.json(`${route}/control`, metadata.owner.cookie, controlSchema, {
    kind: "stop-work",
    workId,
    operationId,
  });
export const callsCompleted = (before: Awaited<ReturnType<typeof observed>>) =>
  waitForFixture(
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
export const heldAcceptance = (before: Awaited<ReturnType<typeof observed>>) =>
  waitForFixture(
    observed,
    (value) =>
      value.held > 0 &&
      completedCalls(value, wireModels.coordinator).length ===
        completedCalls(before, wireModels.coordinator).length + 2,
    60_000
  );
export const matchingReport = (value: unknown, conversationId: string) =>
  queueBodies(value)
    .map((body) =>
      Schema.decodeUnknownSync(TeamReportDeliverySchema, {
        onExcessProperty: "error",
      })(body)
    )
    .find(
      (delivery) =>
        delivery.sourceEventAddress.conversationId === conversationId
    );
export const waitReport = (
  name: string,
  conversationId: string,
  timeoutMs = 30_000
) =>
  waitForFixture(
    () => queue("peek", name, 10),
    (value) => matchingReport(value, conversationId) !== undefined,
    timeoutMs
  );
export const finishCancelledWork = async (conversationId: string) => {
  await fixture.controls({ models: {}, release: true });
  const waiting = await waitReport("cerebro-team-reports", conversationId);
  await controlReportQueue("resume");
  const queueState = await drained("cerebro-team-reports");
  return { waiting, queueState };
};
export const observe = async (route: string) => {
  const abort = new AbortController();
  const response = await fetch(`${boot.apiUrl}${route}/observations`, {
    headers: { Cookie: metadata.owner.cookie, Origin: boot.webUrl },
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async (): Promise<ChatObservation | undefined> => {
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        return Schema.decodeUnknownSync(ChatObservation)(JSON.parse(line));
      }
      const chunk = await reader.read();
      if (chunk.done) {
        return;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  return {
    next,
    close: async () => {
      abort.abort();
      await Promise.allSettled([reader.cancel()]);
      reader.releaseLock();
    },
  };
};
export const access = async (
  actions: string[],
  principalId = metadata.agent.principalId
) => {
  const response = await fixture.request(
    `/api/product/agents/${encodeURIComponent(roles().coordinator.agentId)}/access/${encodeURIComponent(principalId)}`,
    metadata.owner.cookie,
    { operationId: crypto.randomUUID(), actions },
    "PUT"
  );
  assert.equal(response.status, 200, await response.clone().text());
  await response.body?.cancel();
};
