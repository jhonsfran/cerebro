import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { guardedObservation } from "../../packages/api/src/observation-delivery.ts";
import { ChannelError } from "../../packages/channels/src/types.ts";
import { Denied, Unavailable } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { ChatObservation } from "../../packages/contracts/src/session-service.ts";

const snapshot = {
  address: {
    agentId: id.agent("agent-1"),
    conversationId: id.conversation("conversation-1"),
    organizationId: id.organization("organization-1"),
    sessionId: id.session("session-1"),
  },
  agentVersion: 1,
  approvals: [],
  busy: false,
  queuedInputs: [],
  tools: [],
  messages: [
    {
      id: "entry-1",
      role: "assistant",
      state: "complete",
      text: "Respuesta ñ",
    },
  ],
};
const frame = Schema.decodeUnknownSync(ChatObservation)({
  snapshot,
  type: "snapshot",
});
const encode = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(value)}\n`);

const readFrames = async (body: ReadableStream<Uint8Array>) => {
  const text = await new Response(body).text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => Schema.decodeUnknownSync(ChatObservation)(JSON.parse(line)));
};

test(
  "revocation closes an idle upstream body and emits one native denial",
  { timeout: 2000 },
  async () => {
    let cancelled = false;
    let checks = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
    });
    const values = await readFrames(
      guardedObservation({
        authorize: () => {
          checks += 1;
          return Promise.reject(
            new Denied({ code: "revoked", reason: "Access revoked" })
          );
        },
        body,
        recheckMs: 10,
      })
    );
    assert.deepEqual(values, [{ reason: "revoked", type: "access-denied" }]);
    assert.equal(cancelled, true);
    assert.equal(checks, 1);
  }
);

test("native snapshots pass through with identical fragmented UTF-8 bytes", async () => {
  const bytes = encode(frame);
  const unicodeAt = bytes.indexOf(0xc3);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, unicodeAt + 1));
      controller.enqueue(bytes.slice(unicodeAt + 1));
      controller.close();
    },
  });
  const guarded = guardedObservation({
    authorize: () => Promise.resolve(),
    body,
  });
  assert.deepEqual(
    new Uint8Array(await new Response(guarded).arrayBuffer()),
    bytes
  );
});

test(
  "authority failure stops the stream without claiming access denial",
  { timeout: 2000 },
  async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(encode(frame));
      },
    });
    const guarded = guardedObservation({
      authorize: () =>
        Promise.reject(new Unavailable({ reason: "Authority unavailable" })),
      body,
      recheckMs: 10,
    });
    const reader = guarded.getReader();
    const first = await reader.read();
    assert.equal(
      new TextDecoder().decode(first.value),
      new TextDecoder().decode(encode(frame))
    );
    await assert.rejects(
      reader.read(),
      /Current access could not be verified/u
    );
    assert.equal(cancelled, true);
    reader.releaseLock();
  }
);

test(
  "committed sign-out emits access-denied and closes the stream",
  { timeout: 2000 },
  async () => {
    const body = new ReadableStream<Uint8Array>();
    const values = await readFrames(
      guardedObservation({
        authorize: () =>
          Promise.reject(
            new ChannelError(401, "unauthorized", "Authentication was revoked.")
          ),
        body,
        recheckMs: 10,
      })
    );
    assert.deepEqual(values, [{ reason: "revoked", type: "access-denied" }]);
  }
);

test("closing the caller cancels the native observation body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel: () => {
      cancelled = true;
    },
  });
  const guarded = guardedObservation({
    authorize: () => Promise.resolve(),
    body,
  });
  await guarded.cancel();
  assert.equal(cancelled, true);
});
