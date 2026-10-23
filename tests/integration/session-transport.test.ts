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
const identity = {
  organizationId: address.organizationId,
  ownerPrincipalId: userEvent.context.actor.id,
};
const signedRequest = async (
  path: Parameters<typeof signSessionRequest>[2] = "/send",
  target = address,
  owner = identity,
  payload?: unknown
) => {
  const body = JSON.stringify(
    payload ??
      (path === "/send"
        ? { operationId: "send-1", text: "Summarize the support issue." }
        : {})
  );
  return new Request(`https://session.internal${path}`, {
    body,
    headers: {
      "x-cerebro-session-proof": await signSessionRequest(
        target,
        userEvent.context,
        path,
        body,
        secret,
        owner
      ),
    },
    method: "POST",
  });
};

test("native chat credentials authenticate every private operation with the complete address", async () => {
  const paths = [
    "/send",
    "/read",
    "/observe",
    "/decide",
    "/stop",
    "/fork",
    "/control",
  ] as const;
  const results = await Promise.all(
    paths.map(async (path) => {
      const request = await signedRequest(path);
      const resolved = await authenticateSessionRequest(
        request,
        secret,
        identity
      );
      assert.deepEqual(resolved, { address, context: userEvent.context });
      assert.deepEqual(
        JSON.parse(request.headers.get("x-cerebro-session-proof") ?? "null")
          .proof.address,
        address
      );
      assert.deepEqual(
        JSON.parse(request.headers.get("x-cerebro-session-proof") ?? "null")
          .proof.identity,
        identity
      );
      return path;
    })
  );
  assert.deepEqual(results, paths);
});

test("fork and control credentials bind the command body, destination, source chat, and identity host", async () => {
  const destination = {
    ...address,
    conversationId: id.conversation("forked-chat"),
    sessionId: id.session("forked-session"),
  };
  const commands = [
    {
      path: "/fork" as const,
      body: { destination, entryId: "12", operationId: "branch" },
      changed: {
        destination: { ...destination, conversationId: "foreign-chat" },
        entryId: "12",
        operationId: "branch",
      },
    },
    {
      path: "/control" as const,
      body: {
        kind: "schedule",
        instruction: "Review it.",
        operationId: "later",
        runAt: 1_800_000_000_000,
      },
      changed: {
        kind: "schedule",
        instruction: "Run another action.",
        operationId: "later",
        runAt: 1_800_000_000_000,
      },
    },
  ];
  await Promise.all(
    commands.map(async (command) => {
      const request = await signedRequest(
        command.path,
        address,
        identity,
        command.body
      );
      assert.deepEqual(
        await authenticateSessionRequest(request.clone(), secret, identity),
        { address, context: userEvent.context }
      );
      await assert.rejects(
        authenticateSessionRequest(
          new Request(request.url, {
            body: JSON.stringify(command.changed),
            headers: request.headers,
            method: "POST",
          }),
          secret,
          identity
        ),
        Denied
      );
      await assert.rejects(
        authenticateSessionRequest(request.clone(), secret, {
          ...identity,
          ownerPrincipalId: id.principal("foreign-owner"),
        }),
        Denied
      );
      const proof = JSON.parse(
        request.headers.get("x-cerebro-session-proof") ?? "null"
      );
      proof.proof.address.sessionId = destination.sessionId;
      await assert.rejects(
        authenticateSessionRequest(
          new Request(request.url, {
            body: JSON.stringify(command.body),
            headers: { "x-cerebro-session-proof": JSON.stringify(proof) },
            method: "POST",
          }),
          secret,
          identity
        ),
        Denied
      );
    })
  );
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
        authenticateSessionRequest(request, secret, identity),
        Denied
      )
    )
  );
  await Promise.all(
    [
      { ...identity, ownerPrincipalId: id.principal("other-owner") },
      { ...identity, organizationId: id.organization("other-company") },
    ].map((changed) =>
      assert.rejects(
        authenticateSessionRequest(original.clone(), secret, changed),
        Denied
      )
    )
  );
  await Promise.all(
    ["agentId", "conversationId", "organizationId", "sessionId"].map(
      async (field) => {
        const changed = JSON.parse(
          headers.get("x-cerebro-session-proof") ?? "null"
        );
        changed.proof.address[field] = "other-value";
        await assert.rejects(
          authenticateSessionRequest(
            new Request(original.url, {
              body,
              headers: { "x-cerebro-session-proof": JSON.stringify(changed) },
              method: "POST",
            }),
            secret,
            identity
          ),
          Denied
        );
      }
    )
  );
});

test("one signed identity addresses multiple agents and conversations without changing their public addresses", async () => {
  const second = {
    ...address,
    agentId: id.agent("second-agent"),
    conversationId: id.conversation("second-conversation"),
    sessionId: id.session("second-session"),
  };
  const first = await authenticateSessionRequest(
    await signedRequest(),
    secret,
    identity
  );
  const next = await authenticateSessionRequest(
    await signedRequest("/send", second),
    secret,
    identity
  );
  assert.deepEqual(first.address, address);
  assert.deepEqual(next.address, second);
  assert.deepEqual(next.context, userEvent.context);
  await assert.rejects(
    authenticateSessionRequest(
      await signedRequest("/send", {
        ...second,
        organizationId: id.organization("other-company"),
      }),
      secret,
      identity
    ),
    Denied
  );
});
