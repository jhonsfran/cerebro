import assert from "node:assert/strict";
import { test } from "node:test";

import {
  priorInvocationForCall,
  sdkCallKey,
} from "../../packages/runtime/src/tool-call-identity.ts";

test("equal arguments do not merge two calls in one model attempt", () => {
  const firstCall = sdkCallKey({ callId: "call-1", messageId: "message-1" });
  const secondCall = sdkCallKey({ callId: "call-2", messageId: "message-1" });
  const first = {
    boundModelAttemptId: "attempt-1",
    operationId: "effect-1",
    sdkCallIds: [firstCall],
  };
  assert.equal(
    priorInvocationForCall([first], secondCall, "attempt-1", new Set()),
    undefined
  );
});

test("a restarted attempt binds each repeated call to one prior invocation", () => {
  const first = {
    boundModelAttemptId: "attempt-1",
    operationId: "effect-1",
    sdkCallIds: [sdkCallKey({ callId: "old-1", messageId: "old-message" })],
  };
  const second = {
    boundModelAttemptId: "attempt-1",
    operationId: "effect-2",
    sdkCallIds: [sdkCallKey({ callId: "old-2", messageId: "old-message" })],
  };
  const firstReplay = sdkCallKey({ callId: "new-1", messageId: "new-message" });
  const secondReplay = sdkCallKey({
    callId: "new-2",
    messageId: "new-message",
  });
  assert.equal(
    priorInvocationForCall([first, second], firstReplay, "attempt-2", new Set())
      ?.operationId,
    "effect-1"
  );
  const rebound = {
    ...first,
    boundModelAttemptId: "attempt-2",
    sdkCallIds: [...first.sdkCallIds, firstReplay],
  };
  assert.equal(
    priorInvocationForCall(
      [rebound, second],
      secondReplay,
      "attempt-2",
      new Set()
    )?.operationId,
    "effect-2"
  );
});

test("a completed model call is not rebound after restart", () => {
  const oldCall = sdkCallKey({ callId: "old", messageId: "old-message" });
  const first = {
    boundModelAttemptId: "attempt-1",
    operationId: "effect-1",
    sdkCallIds: [oldCall],
  };
  assert.equal(
    priorInvocationForCall(
      [first],
      sdkCallKey({ callId: "new", messageId: "new-message" }),
      "attempt-2",
      new Set([oldCall])
    ),
    undefined
  );
});
