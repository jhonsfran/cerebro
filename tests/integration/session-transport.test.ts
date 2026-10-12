import assert from "node:assert/strict";
import { test } from "node:test";

import {
  authenticateSessionRequest,
  signSessionRequest,
} from "../../apps/server/src/session/proof.ts";
import { Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { userEvent } from "../support/fixtures.ts";

const secret = "fixture-secret-for-transport-tests-0001";
const address = {
  agentId: userEvent.agentId,
  conversationId: userEvent.conversationId,
  organizationId: userEvent.organizationId,
  sessionId: userEvent.sessionId,
};
const signedRequest = async (
  path: Parameters<typeof signSessionRequest>[2] = "/send"
) => {
  const body = JSON.stringify(
    path === "/send"
      ? { operationId: "send-1", text: "Summarize the support issue." }
      : {}
  );
  return new Request(`https://session.internal${path}`, {
    body,
    headers: {
      "x-cerebro-session-proof": await signSessionRequest(
        address,
        userEvent.context,
        path,
        body,
        secret
      ),
    },
    method: "POST",
  });
};

test("native chat credentials authenticate every private operation with the complete address", async () => {
  const paths = ["/send", "/read", "/observe", "/decide", "/stop"] as const;
  const results = await Promise.all(
    paths.map(async (path) => {
      const request = await signedRequest(path);
      const context = await authenticateSessionRequest(
        request,
        secret,
        address
      );
      assert.deepEqual(context, userEvent.context);
      assert.deepEqual(
        JSON.parse(request.headers.get("x-cerebro-session-proof") ?? "null")
          .proof.address,
        address
      );
      return path;
    })
  );
  assert.deepEqual(results, paths);
});

test("private chat credentials reject changed bodies, actors, addresses, routes, and unsigned callers", async () => {
  const original = await signedRequest();
  const body = await original.clone().text();
  const { headers } = original;
  const forged = JSON.parse(headers.get("x-cerebro-session-proof") ?? "null");
  forged.proof.context.actor.id = "other-actor";
  const requests = [
    new Request(original.url, { body: `${body} `, headers, method: "POST" }),
    new Request("https://session.internal/stop", {
      body,
      headers,
      method: "POST",
    }),
    new Request(original.url, { body, method: "POST" }),
    new Request(original.url, {
      body,
      headers: { "x-cerebro-session-proof": JSON.stringify(forged) },
      method: "POST",
    }),
  ];
  await Promise.all(
    requests.map((request) =>
      assert.rejects(
        authenticateSessionRequest(request, secret, address),
        Denied
      )
    )
  );
  await Promise.all(
    [
      { ...address, sessionId: id.session("other-session") },
      { ...address, agentId: id.agent("other-agent") },
      { ...address, conversationId: id.conversation("other-conversation") },
      { ...address, organizationId: id.organization("other-company") },
    ].map((changed) =>
      assert.rejects(
        authenticateSessionRequest(original.clone(), secret, changed),
        Denied
      )
    )
  );
});
