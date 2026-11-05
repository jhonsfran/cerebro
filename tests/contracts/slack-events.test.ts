import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { SlackPrimaryDecisionSchema } from "../../packages/contracts/src/slack-events.ts";

const decision = {
  kind: "primary-events-v2",
  ownerPrincipalId: "owner-A",
  authority: {
    appId: "app-A",
    eventId: "event-A",
    userId: "user-A",
    thread: {
      workspaceId: "workspace-A",
      channelId: "D-A",
      rootTimestamp: "1800000000.000001",
    },
  },
  text: "A saved Slack request.",
  targets: [
    {
      organizationId: "org-A",
      agentId: "bot-A",
      conversationId: "primary-A",
      sessionId: "session-A",
    },
  ],
};
const decode = Schema.decodeUnknownSync(SlackPrimaryDecisionSchema, {
  onExcessProperty: "error",
});

test("new Slack decisions retain complete reply authority and reject additional or missing fields", () => {
  assert.deepEqual(decode(decision), decision);
  assert.throws(() => decode({ ...decision, credential: "not-allowed" }));
  assert.throws(() =>
    decode({
      ...decision,
      authority: { ...decision.authority, userId: undefined },
    })
  );
  assert.throws(() => decode({ ...decision, targets: [] }));
  assert.throws(() =>
    decode({
      ...decision,
      targets: Array.from({ length: 19 }, () => decision.targets[0]),
    })
  );
  assert.throws(() => decode({ ...decision, text: "x".repeat(16_001) }));
  assert.equal(
    decode({ ...decision, text: "x".repeat(16_000) }).text.length,
    16_000
  );
});
