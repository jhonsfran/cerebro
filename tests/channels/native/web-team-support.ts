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
import {
  BackgroundWorkSnapshot,
  WorkKeySchema,
} from "../../../packages/contracts/src/work.ts";
import { waitForFixture } from "../../slice-1/application.ts";
import { matchingWorkReport } from "./team-queue-support.ts";
import type { WorkTarget } from "./team-queue-support.ts";
import {
  agentWireModel,
  boot,
  completedCalls,
  queue,
  compose,
  fixture,
  metadata,
  observed,
  teamRoles,
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
export const coordinatorTools = [
  "start_team",
  "get_work",
  "message_team",
  "stop_work",
  "list_work",
  "recall_work",
  "subscribe_work",
  "unsubscribe_work",
];
let published: z.infer<typeof publishedSchema> | undefined;
export const publishedAgent = () => {
  assert.ok(
    published,
    "Publish the fixture agent before using the web team helper."
  );
  return published;
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
    "SELECT json_build_object('links',(SELECT count(*) FROM identity_slack_link),'challenges',(SELECT count(*) FROM identity_slack_link_challenge),'slackAccounts',(SELECT count(*) FROM connector_account WHERE id ILIKE '%slack%' OR label ILIKE '%slack%'))"
  );
  const value = {
    ...z
      .object({ slackConfigured: z.boolean() })
      .parse(JSON.parse(configuration.stdout)),
    ...z
      .object({
        links: z.number(),
        challenges: z.number(),
        slackAccounts: z.number(),
      })
      .parse(JSON.parse(counts)),
  };
  assert.deepEqual(value, {
    slackConfigured: false,
    links: 0,
    challenges: 0,
    slackAccounts: 0,
  });
  return value;
};

export const setupWebTeam = async () => {
  published = await fixture.json(
    "/api/product/agents",
    metadata.owner.cookie,
    publishedSchema,
    {
      operationId: crypto.randomUUID(),
      name: "Web coordinator",
      model: `fixture/${agentWireModel}`,
      instructions: "Use the supplied bounded team tools.",
      enabledToolIds: [],
      grants: [],
    }
  );
  await fixture.controls({
    arm: null,
    delayMs: 0,
    failFirst: false,
    models: {},
    release: true,
  });
  await noSlack();
};

export const createConversation = async (
  agentId = publishedAgent().agentId
) => {
  const conversation = await fixture.json(
    "/api/product/conversations",
    metadata.owner.cookie,
    conversationSchema,
    {
      agentId,
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
export const sendTurn = async (route: string, text: string) => {
  const before = await read(route);
  const messages = new Set(
    before.snapshot.messages.map((message) => message.id)
  );
  const tools = new Set(before.snapshot.tools.map((tool) => tool.id));
  const input = { operationId: crypto.randomUUID(), text };
  const receipt = await sendMessage(route, input);
  const view = await waitForFixture(
    () => read(route),
    (value) =>
      !value.snapshot.busy &&
      value.snapshot.messages.some(
        (message) =>
          !messages.has(message.id) &&
          message.role === "user" &&
          message.text === text
      ) &&
      value.snapshot.messages.some(
        (message) =>
          !messages.has(message.id) &&
          message.role === "assistant" &&
          message.state === "complete" &&
          message.outcome !== "tool-call"
      ),
    60_000
  );
  return {
    before,
    input,
    receipt,
    view,
    tools: view.snapshot.tools.filter((tool) => !tools.has(tool.id)),
  };
};
export const startedWork = (snapshot: ChatSnapshot, goal: string) => {
  const starts = snapshot.tools.filter((tool) => {
    const args = z.object({ goal: z.string() }).safeParse(tool.arguments);
    return (
      tool.toolName === "start_team" && args.success && args.data.goal === goal
    );
  });
  assert.ok(
    starts.length <= 1,
    "One goal must have one native start tool occurrence."
  );
  const [call] = starts;
  if (!call || call.state !== "succeeded") {
    return;
  }
  const work = Schema.decodeUnknownSync(BackgroundWorkSnapshot)(
    JSON.parse(call.output)
  );
  const key = Schema.decodeUnknownSync(WorkKeySchema)({
    organizationId: snapshot.address.organizationId,
    ownerPrincipalId: metadata.agent.principalId,
    workId: work.workId,
  });
  assert.ok(call.resultMessageId);
  return { call, work, key, sourceEventAddress: snapshot.address };
};
export const waitStartedWork = (route: string, goal: string) =>
  waitForFixture(
    async () => {
      const view = await read(route);
      return { view, work: startedWork(view.snapshot, goal) };
    },
    (value) => !value.view.snapshot.busy && value.work !== undefined,
    60_000
  );
export const waitWorkReport = (
  name: string,
  target: WorkTarget,
  timeoutMs = 30_000,
  reportId?: string
) =>
  waitForFixture(
    () => queue("peek", name, 50),
    (value) => matchingWorkReport(value, target, reportId) !== undefined,
    timeoutMs
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
      completedCalls(value, teamRoles.coordinator).length ===
        completedCalls(before, teamRoles.coordinator).length + 2 &&
      completedCalls(value, teamRoles.lead).length ===
        completedCalls(before, teamRoles.lead).length + 2 &&
      completedCalls(value, teamRoles.worker).length ===
        completedCalls(before, teamRoles.worker).length + 2,
    90_000
  );
export const heldAcceptance = (before: Awaited<ReturnType<typeof observed>>) =>
  waitForFixture(
    observed,
    (value) =>
      value.held > 0 &&
      completedCalls(value, teamRoles.coordinator).length ===
        completedCalls(before, teamRoles.coordinator).length + 2,
    60_000
  );
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
  principalId = metadata.agent.principalId,
  agentId = publishedAgent().agentId
) => {
  const response = await fixture.request(
    `/api/product/agents/${encodeURIComponent(agentId)}/access/${encodeURIComponent(principalId)}`,
    metadata.owner.cookie,
    { operationId: crypto.randomUUID(), actions },
    "PUT"
  );
  assert.equal(response.status, 200, await response.clone().text());
  await response.body?.cancel();
};
