import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

const api = process.env.CHANNEL_NATIVE_API_URL;
const project = process.env.CHANNEL_NATIVE_COMPOSE_PROJECT;
if (!api || !project) {
  throw new Error(
    "CHANNEL_NATIVE_API_URL and CHANNEL_NATIVE_COMPOSE_PROJECT are required for recovery."
  );
}
const compose = (args: string[]): string => {
  const result = spawnSync(
    "docker",
    ["compose", "--project-name", project, ...args],
    { encoding: "utf-8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const query = (sql: string): string =>
  compose([
    "exec",
    "--no-TTY",
    "postgres",
    "psql",
    "--username",
    "cerebro",
    "--dbname",
    "cerebro",
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    sql,
  ]);
const identifier = z.string().regex(/^[a-zA-Z0-9:_-]+$/u);

test("the native durable alarm admits a pending message after SIGKILL without a channel request", async () => {
  const signin = await fetch(`${api}/api/auth/sign-in/email`, {
    body: JSON.stringify({
      email: "session6-pilot@example.test",
      password: "Session6-fixture-2026!",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(signin.status, 200);
  const cookie = signin.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const headers = { "Content-Type": "application/json", Cookie: cookie };
  const agentsResponse = await fetch(`${api}/api/product/agents`, { headers });
  const agents = z
    .object({ agents: z.array(z.object({ agentId: identifier })) })
    .parse(await agentsResponse.json());
  const [agent] = agents.agents;
  assert.ok(agent);
  const create = await fetch(`${api}/api/product/conversations`, {
    body: JSON.stringify({ agentId: agent.agentId, operationId: randomUUID() }),
    headers,
    method: "POST",
  });
  const conversation = z
    .object({ conversationId: identifier })
    .parse(await create.json());
  const message = await fetch(
    `${api}/api/product/conversations/${encodeURIComponent(conversation.conversationId)}/messages`,
    {
      body: JSON.stringify({
        eventId: randomUUID(),
        text: "Recovery source message",
      }),
      headers,
      method: "POST",
    }
  );
  assert.equal(message.status, 200, await message.clone().text());
  const eventKey = `native-recovery-${randomUUID()}`;
  const eventId = `event:${randomUUID()}`;
  compose(["kill", "--signal", "SIGKILL", "celld"]);
  try {
    query(
      `INSERT INTO channel_inbox (event_key, organization_id, conversation_id, digest, envelope, state, receipt) SELECT '${eventKey}', organization_id, conversation_id, digest, jsonb_set(envelope, '{eventId}', to_jsonb('${eventId}'::text)), 'pending', NULL FROM channel_inbox WHERE conversation_id = '${conversation.conversationId}' LIMIT 1`
    );
  } finally {
    compose(["start", "celld"]);
  }
  const evidenceSchema = z.object({ runCount: z.number(), state: z.string() });
  const observe = async (
    remaining: number
  ): Promise<z.infer<typeof evidenceSchema>> => {
    const evidence = evidenceSchema.parse(
      JSON.parse(
        query(
          `SELECT json_build_object('state', state, 'runCount', (SELECT count(*) FROM channel_fixture_run WHERE event_id = '${eventId}')) FROM channel_inbox WHERE event_key = '${eventKey}'`
        )
      )
    );
    if (evidence.state === "accepted" || remaining === 0) {
      return evidence;
    }
    await delay(3000);
    return observe(remaining - 1);
  };
  const evidence = await observe(100);
  assert.deepEqual(evidence, { runCount: 1, state: "accepted" });
});
