import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { z } from "zod";

const api = process.env.CHANNEL_NATIVE_API_URL;
if (!api) {
  throw new Error(
    "CHANNEL_NATIVE_API_URL is required for the native channel test."
  );
}
const owner = {
  email: "session6-pilot@example.test",
  name: "Session 6 pilot",
  password: "Session6-fixture-2026!",
};
const cookieFrom = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
const auth = async (
  email: string,
  name: string,
  password: string
): Promise<string> => {
  const input = { email, name, password };
  const signup = await fetch(`${api}/api/auth/sign-up/email`, {
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (signup.ok) {
    return cookieFrom(signup);
  }
  const signin = await fetch(`${api}/api/auth/sign-in/email`, {
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(signin.status, 200, await signin.text());
  return cookieFrom(signin);
};
const call = (
  cookie: string,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown
) => {
  const headers = { "Content-Type": "application/json", Cookie: cookie };
  if (method === "GET") {
    return fetch(`${api}/api/product/${path}`, { headers });
  }
  return fetch(`${api}/api/product/${path}`, {
    body: JSON.stringify(body),
    headers,
    method: "POST",
  });
};
const json = async (response: Response): Promise<unknown> => {
  assert.equal(
    response.ok,
    true,
    `${response.status} ${await response.clone().text()}`
  );
  return response.json();
};
const createdAgent = z.object({ agentId: z.string(), version: z.number() });
const createdConversation = z.object({
  conversationId: z.string(),
  sessionId: z.string(),
});
const receiptSchema = z.object({
  receipt: z.object({ acceptedEventId: z.string(), runId: z.string() }),
});
const presentation = z
  .object({
    approvalId: z.string().optional(),
    cursor: z.string(),
    run: z.object({ runId: z.string(), state: z.string() }).optional(),
    sourceId: z.string().optional(),
    type: z.string(),
  })
  .passthrough();
const conversationSchema = z.object({
  cursor: z.string(),
  items: z.array(presentation),
  sessionId: z.string(),
  snapshot: z.object({
    runs: z.array(z.object({ runId: z.string(), state: z.string() })),
  }),
});

test("native celld channel flow persists replay, citations, reconnect, approval, and denial", async () => {
  const origin = process.env.CHANNEL_NATIVE_WEB_URL ?? "http://localhost:3006";
  const preflight = await fetch(`${api}/api/auth/sign-in/email`, {
    headers: {
      "Access-Control-Request-Headers": "content-type",
      "Access-Control-Request-Method": "POST",
      Origin: origin,
    },
    method: "OPTIONS",
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), origin);
  const cookie = await auth(owner.email, owner.name, owner.password);
  const setup = await call(cookie, "setup", "POST", {
    operationId: "native-fixture-owner",
  });
  assert.equal(setup.status, 200, await setup.clone().text());
  const input = {
    enabledToolIds: ["fixture-read"],
    grants: [],
    instructions: "Answer from the local pilot source.",
    model: "fixture-model",
    name: "Native pilot assistant",
    operationId: randomUUID(),
  };
  const agent = createdAgent.parse(
    await json(await call(cookie, "agents", "POST", input))
  );
  assert.equal(agent.version, 1);
  const repeatedAgent = createdAgent.parse(
    await json(await call(cookie, "agents", "POST", input))
  );
  assert.deepEqual(repeatedAgent, agent);
  const conversation = createdConversation.parse(
    await json(
      await call(cookie, "conversations", "POST", {
        agentId: agent.agentId,
        operationId: randomUUID(),
      })
    )
  );
  const message = {
    eventId: randomUUID(),
    text: "How does durable admission work?",
  };
  const replies = await Promise.all([
    call(
      cookie,
      `conversations/${conversation.conversationId}/messages`,
      "POST",
      message
    ),
    call(
      cookie,
      `conversations/${conversation.conversationId}/messages`,
      "POST",
      message
    ),
  ]);
  const receipts = await Promise.all(
    replies.map(async (response) => receiptSchema.parse(await json(response)))
  );
  assert.equal(receipts[0]?.receipt.runId, receipts[1]?.receipt.runId);
  const path = `conversations/${conversation.conversationId}`;
  const first = conversationSchema.parse(await json(await call(cookie, path)));
  assert.equal(first.sessionId, conversation.sessionId);
  assert.equal(first.items.filter((item) => item.type === "user").length, 1);
  assert.equal(first.snapshot.runs[0]?.state, "completed");
  const citation = first.items.find((item) => item.type === "citation");
  assert.equal(citation?.sourceId, "pilot-source");
  const source = z
    .object({ mode: z.string(), text: z.string() })
    .parse(await json(await call(cookie, `${path}/sources/pilot-source`)));
  assert.equal(source.mode, "fixture");
  assert.match(source.text, /stable ID/u);
  const reconnect = await call(
    cookie,
    `${path}/events?cursor=${encodeURIComponent(first.cursor)}`
  );
  assert.equal(reconnect.status, 200);
  const reconnectText = await reconnect.text();
  assert.equal(reconnectText.includes("data:"), false);
  const approvalInput = {
    eventId: randomUUID(),
    text: "Run the approval fixture",
  };
  await json(await call(cookie, `${path}/messages`, "POST", approvalInput));
  const waiting = conversationSchema.parse(
    await json(await call(cookie, path))
  );
  const pending = waiting.items.find((item) => item.type === "approval");
  assert.equal(typeof pending?.approvalId, "string");
  const approved = await call(
    cookie,
    `${path}/approvals/${encodeURIComponent(pending?.approvalId ?? "")}`,
    "POST",
    { operationId: randomUUID() }
  );
  assert.equal(approved.status, 200, await approved.clone().text());
  const final = conversationSchema.parse(await json(await call(cookie, path)));
  assert.equal(
    final.snapshot.runs.every((run) => run.state === "completed"),
    true
  );
  const outsiderCookie = await auth(
    `${randomUUID()}@example.test`,
    "No grants",
    "Session6-fixture-2026!"
  );
  const outsiderSetup = await call(outsiderCookie, "setup", "POST", {
    operationId: randomUUID(),
  });
  assert.equal(outsiderSetup.status, 403);
  const outsiderMessage = await call(
    outsiderCookie,
    `${path}/messages`,
    "POST",
    { eventId: randomUUID(), text: "Denied" }
  );
  assert.equal(outsiderMessage.status, 403);
});
