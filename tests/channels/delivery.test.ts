/* oxlint-disable no-await-in-loop -- Delivery checks wait for serial lifecycle transitions. */
import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import type { ChatReceipt } from "../../packages/contracts/src/session-service.ts";

mock.module("../../apps/web/src/env.public", () => ({
  ENV: { VITE_SERVER_URL: "http://fixture.invalid" },
}));
const { createMessageDelivery } =
  await import("../../apps/web/src/features/product/chat-delivery");
const { ProductError } =
  await import("../../apps/web/src/features/product/api");
const { CHAT_MESSAGE_LENGTH_ERROR } =
  await import("../../apps/web/src/features/product/chat");
const message = { operationId: "original-operation", text: "Question" };
const receipt = {
  accepted: false,
  operationId: "original-operation",
  session: "session",
};
const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await delay(5);
  }
  assert.fail("Message delivery did not settle.");
};

test("delivery rejects 16001 characters before pending admission and accepts 16000", async () => {
  let pending: typeof message | null = null;
  const submitted: (typeof message)[] = [];
  const stored: (typeof message | null)[] = [];
  const errors: string[] = [];
  const delivery = createMessageDelivery({
    generation: () => 0,
    onConfirmed: () => {},
    onState: (state) => {
      if (state.status === "blocked") {
        errors.push(state.error);
      }
    },
    read: () => pending,
    store: (value) => {
      pending = value;
      stored.push(value);
    },
    submit: (value) => {
      submitted.push(value);
      return Promise.resolve({
        ...receipt,
        accepted: true,
        operationId: value.operationId,
      });
    },
  });
  try {
    delivery.connect();
    delivery.send({ operationId: "oversized", text: "x".repeat(16_001) });
    assert.deepEqual(errors, [CHAT_MESSAGE_LENGTH_ERROR]);
    assert.equal(pending, null);
    assert.deepEqual(stored, []);
    assert.deepEqual(submitted, []);
    const accepted = { operationId: "at-limit", text: "x".repeat(16_000) };
    delivery.send(accepted);
    await waitFor(() => pending === null);
    assert.deepEqual(submitted, [accepted]);
    assert.deepEqual(stored, [accepted, null]);
  } finally {
    delivery.dispose();
  }
});

test("a lost receipt retries the same input and a duplicate receipt confirms it once", async () => {
  let pending: typeof message | null = message;
  const submitted: (typeof message)[] = [];
  const confirmed: (typeof message)[] = [];
  const states: string[] = [];
  const delivery = createMessageDelivery({
    generation: () => 0,
    onConfirmed: (value) => confirmed.push(value),
    onState: (state) => states.push(state.status),
    read: () => pending,
    retryDelayMs: 1,
    store: (value) => {
      pending = value;
    },
    submit: (value) => {
      submitted.push(value);
      if (submitted.length === 1) {
        return Promise.reject(new TypeError("Network connection closed"));
      }
      return Promise.resolve(receipt);
    },
  });
  try {
    delivery.connect();
    delivery.connect();
    delivery.retry();
    await waitFor(() => confirmed.length === 1);
    assert.deepEqual(submitted, [message, message]);
    assert.deepEqual(confirmed, [message]);
    assert.equal(pending, null);
    assert.deepEqual(states, ["sending", "waiting", "sending", "idle"]);
  } finally {
    delivery.dispose();
  }
});

test("transient retries stop after three attempts until the user retries", async () => {
  let pending: typeof message | null = message;
  let submissions = 0;
  let state = "idle";
  const delivery = createMessageDelivery({
    generation: () => 0,
    onConfirmed: () => {},
    onState: (value) => {
      state = value.status;
    },
    read: () => pending,
    retryDelayMs: 1,
    store: (value) => {
      pending = value;
    },
    submit: () => {
      submissions += 1;
      if (submissions <= 3) {
        return Promise.reject(new ProductError(503, "Unknown outcome"));
      }
      return Promise.resolve(receipt);
    },
  });
  try {
    delivery.connect();
    await waitFor(() => state === "blocked");
    delivery.disconnect();
    delivery.connect();
    await delay(15);
    assert.equal(submissions, 3);
    assert.deepEqual(pending, message);
    delivery.retry();
    await waitFor(() => pending === null);
    assert.equal(submissions, 4);
    assert.equal(state, "idle");
  } finally {
    delivery.dispose();
  }
});

for (const failure of ["rejected", "mismatched"] as const) {
  test(`${failure} receipts preserve the pending input without automatic retries`, async () => {
    let pending: typeof message | null = message;
    let submissions = 0;
    let state = "idle";
    const delivery = createMessageDelivery({
      generation: () => 0,
      onConfirmed: () => {},
      onState: (value) => {
        state = value.status;
      },
      read: () => pending,
      retryDelayMs: 1,
      store: (value) => {
        pending = value;
      },
      submit: () => {
        submissions += 1;
        if (submissions === 1) {
          if (failure === "rejected") {
            return Promise.reject(new ProductError(409, "Operation conflict"));
          }
          return Promise.resolve({
            ...receipt,
            operationId: "another-operation",
          });
        }
        return Promise.resolve(receipt);
      },
    });
    try {
      delivery.connect();
      await waitFor(() => state === "blocked");
      delivery.disconnect();
      delivery.connect();
      await delay(15);
      assert.equal(submissions, 1);
      assert.deepEqual(pending, message);
      delivery.retry();
      await waitFor(() => pending === null);
      assert.equal(submissions, 2);
    } finally {
      delivery.dispose();
    }
  });
}

test("disconnect aborts delivery and reconnect ignores the previous attempt's receipt", async () => {
  let pending: typeof message | null = message;
  const attempts: {
    signal: AbortSignal;
    complete: (value: ChatReceipt) => void;
  }[] = [];
  const confirmed: (typeof message)[] = [];
  const delivery = createMessageDelivery({
    generation: () => 0,
    onConfirmed: (value) => confirmed.push(value),
    onState: () => {},
    read: () => pending,
    store: (value) => {
      pending = value;
    },
    submit: (_value, signal) => {
      const result = Promise.withResolvers<ChatReceipt>();
      attempts.push({ complete: result.resolve, signal });
      return result.promise;
    },
  });
  try {
    delivery.connect();
    delivery.send(message);
    assert.equal(attempts.length, 1);
    delivery.disconnect();
    assert.equal(attempts[0]?.signal.aborted, true);
    delivery.connect();
    attempts[0]?.complete(receipt);
    await delay(0);
    assert.deepEqual(pending, message);
    attempts[1]?.complete(receipt);
    await waitFor(() => pending === null);
    assert.equal(attempts.length, 2);
    assert.deepEqual(confirmed, [message]);
  } finally {
    delivery.dispose();
  }
});

test("revocation and disposal cancel retry timers and cannot restore pending input", async () => {
  let generation = 0;
  let pending: typeof message | null = message;
  let submissions = 0;
  let state = "idle";
  const confirmed: (typeof message)[] = [];
  const delivery = createMessageDelivery({
    generation: () => generation,
    onConfirmed: (value) => confirmed.push(value),
    onState: (value) => {
      state = value.status;
    },
    read: () => pending,
    retryDelayMs: 10,
    store: (value) => {
      pending = value;
    },
    submit: () => {
      submissions += 1;
      return Promise.reject(new ProductError(503, "Unknown outcome"));
    },
  });
  delivery.connect();
  await waitFor(() => state === "waiting");
  generation += 1;
  pending = null;
  delivery.dispose();
  delivery.connect();
  delivery.retry();
  await delay(30);
  assert.equal(submissions, 1);
  assert.equal(pending, null);
  assert.deepEqual(confirmed, []);
  assert.equal(state, "waiting");
});

test("revocation aborts the active request and ignores a delayed successful receipt", async () => {
  let generation = 0;
  let pending: typeof message | null = message;
  let signal: AbortSignal | undefined;
  const result = Promise.withResolvers<ChatReceipt>();
  const confirmed: (typeof message)[] = [];
  const states: string[] = [];
  const delivery = createMessageDelivery({
    generation: () => generation,
    onConfirmed: (value) => confirmed.push(value),
    onState: (value) => states.push(value.status),
    read: () => pending,
    store: (value) => {
      pending = value;
    },
    submit: (_value, requestSignal) => {
      signal = requestSignal;
      return result.promise;
    },
  });
  delivery.connect();
  generation += 1;
  pending = null;
  delivery.dispose();
  result.resolve(receipt);
  await delay(0);
  assert.equal(signal?.aborted, true);
  assert.equal(pending, null);
  assert.deepEqual(confirmed, []);
  assert.deepEqual(states, ["sending"]);
});
