import { test } from "bun:test";
import assert from "node:assert/strict";

import { Schema } from "effect";

import {
  isCoordinatorConversation,
  requireLegacySourceMatch,
} from "../../apps/server/src/session/coordination";
import { WorkAdmissionSchema } from "../../packages/contracts/src/work";

const conversation = {
  agentId: "coordinator",
  bindingKey: "web-source",
  channelId: null,
  conversationId: "source",
  createdAt: new Date(),
  engine: "pi-identity-v1" as const,
  forkOrigin: null,
  kind: "web" as const,
  organizationId: "organization",
  ownerPrincipalId: "owner",
  retiredAt: null,
  rootTimestamp: null,
  sessionId: "source",
  slackUserId: null,
  workspaceId: null,
};
const slack = {
  agentId: "coordinator",
  apiUrl: "http://fixture.invalid/slack",
  appId: "app",
  botToken: "fixture-token",
  signingSecret: "fixture-secret",
  workspaceId: "workspace",
};
const slackConversation = {
  ...conversation,
  kind: "slack" as const,
  channelId: "D-source",
  rootTimestamp: "1800000000.000001",
  workspaceId: slack.workspaceId,
};

test("a resolved web source needs no Slack configuration", () => {
  assert.equal(isCoordinatorConversation(conversation), true);
  assert.equal(isCoordinatorConversation(conversation, slack), true);
  assert.equal(isCoordinatorConversation(slackConversation), false);
  assert.equal(isCoordinatorConversation(slackConversation, slack), true);
  assert.throws(() =>
    isCoordinatorConversation({
      ...conversation,
      ...JSON.parse('{"kind":"unknown"}'),
    })
  );
  for (const changed of [
    { agentId: "other" },
    { workspaceId: "other" },
    { channelId: null },
    { channelId: "" },
    { rootTimestamp: "1800000000" },
    { rootTimestamp: null },
  ]) {
    assert.equal(
      isCoordinatorConversation({ ...slackConversation, ...changed }, slack),
      false
    );
  }
});

test("retained legacy metadata requires the exact trusted Slack source row", () => {
  const work = Schema.decodeUnknownSync(WorkAdmissionSchema)({
    admittedAt: 1000,
    contentDependencies: { sourceIds: [], toolIds: [] },
    deadlineAt: 61_000,
    goal: "Read.",
    key: {
      organizationId: "organization",
      ownerPrincipalId: "owner",
      workId: "work",
    },
    lead: { agentId: "lead", agentVersion: 1 },
    limits: { maxTeams: 2, maxWorkers: 2, maxTurns: 8, timeoutMs: 60_000 },
    sourceEventAddress: {
      agentId: "coordinator",
      conversationId: "source",
      organizationId: "organization",
      sessionId: "source",
    },
    sourceSlackThread: {
      channelId: "D-source",
      workspaceId: "workspace",
      rootTimestamp: "1800000000.000001",
    },
    worker: { agentId: "worker", agentVersion: 1 },
  });
  requireLegacySourceMatch(work, slackConversation);
  for (const row of [
    conversation,
    { ...slackConversation, channelId: "D-other" },
    { ...slackConversation, workspaceId: "other" },
    { ...slackConversation, rootTimestamp: "1800000001.000001" },
  ]) {
    assert.throws(() => requireLegacySourceMatch(work, row));
  }
});
