import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import {
  authenticateSessionRequest,
  signSessionRequest,
} from "../../apps/server/src/session-proof.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { userEvent } from "../../packages/contracts/src/testing/fixtures.ts";

const secret = "fixture-secret-for-transport-tests-0001";
const address = {
  agentId: userEvent.agentId,
  conversationId: userEvent.conversationId,
  organizationId: userEvent.organizationId,
  sessionId: userEvent.sessionId,
};
const signedRequest = async () => {
  const body = JSON.stringify({
    command: { event: userEvent, mode: "follow-up", type: "submit" },
  });
  return new Request("https://session.internal/submit", {
    body,
    headers: {
      "x-cerebro-session-proof": await signSessionRequest(
        userEvent,
        userEvent.context,
        "/submit",
        body,
        secret
      ),
    },
    method: "POST",
  });
};
test("submission credentials contain only the complete address when supplied an event envelope", async () => {
  const request = await signedRequest();
  assert.deepEqual(
    await Effect.runPromise(
      authenticateSessionRequest(request, secret, address)
    ),
    userEvent.context
  );
  assert.deepEqual(
    JSON.parse(request.headers.get("x-cerebro-session-proof") ?? "null").proof
      .address,
    address
  );
});
test("private session credentials reject changed bodies, addresses, routes, and unsigned callers", async () => {
  const original = await signedRequest();
  const body = await original.clone().text();
  const { headers } = original;
  const requests = [
    new Request(original.url, { body: `${body} `, headers, method: "POST" }),
    new Request("https://session.internal/cancel", {
      body,
      headers,
      method: "POST",
    }),
    new Request(original.url, { body, method: "POST" }),
  ];
  await Promise.all(
    requests.map(async (request) => {
      await assert.rejects(
        Effect.runPromise(authenticateSessionRequest(request, secret, address)),
        (error: unknown) =>
          error instanceof Error && "_tag" in error && error._tag === "Denied"
      );
    })
  );
  await assert.rejects(
    Effect.runPromise(
      authenticateSessionRequest(original.clone(), secret, {
        ...address,
        sessionId: id.session("other-session"),
      })
    )
  );
});
