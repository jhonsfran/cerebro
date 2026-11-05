import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import {
  BotEventSchema,
  botEventId,
} from "../../packages/contracts/src/bot-events.ts";
import type { BotEvent } from "../../packages/contracts/src/bot-events.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { digestToolArguments } from "../../packages/contracts/src/tools.ts";
import {
  WorkIdSchema,
  WorkReportIdSchema,
} from "../../packages/contracts/src/work.ts";

const coordinator = {
  organizationId: id.organization("org"),
  agentId: id.agent("bot"),
  conversationId: id.conversation("chat"),
  sessionId: id.session("session"),
};
const key = {
  organizationId: coordinator.organizationId,
  ownerPrincipalId: id.principal("owner"),
  workId: Schema.decodeUnknownSync(WorkIdSchema)("work"),
};
const source = {
  kind: "teamreport",
  key,
  reportId: Schema.decodeUnknownSync(WorkReportIdSchema)("report"),
  outcome: "completed",
} satisfies BotEvent["source"];
const event = async (): Promise<BotEvent> => ({
  version: 1,
  id: await botEventId(coordinator, source),
  coordinator,
  ownerPrincipalId: key.ownerPrincipalId,
  source,
  replyTo: null,
  content: { text: "Report summary.", reference: { kind: "work", key } },
  dependencies: { sourceIds: [], toolIds: [] },
});

test("report identity binds the bot and source ID while changed immutable content changes its digest", async () => {
  const original = await event();
  const changed = {
    ...original,
    source: { ...source, outcome: "failed" as const },
  };
  assert.equal(original.id, await botEventId(coordinator, changed.source));
  assert.notEqual(
    await digestToolArguments(original),
    await digestToolArguments(changed)
  );
  assert.notEqual(
    original.id,
    await botEventId({ ...coordinator, agentId: id.agent("other-bot") }, source)
  );
});

test("new event schemas reject excess mutable fields, foreign ownership and unbounded inline content", async () => {
  const original = await event();
  const decode = Schema.decodeUnknownSync(BotEventSchema, {
    onExcessProperty: "error",
  });
  assert.deepEqual(decode(original), original);
  assert.throws(() => decode({ ...original, digest: "mutable-digest" }));
  assert.throws(() =>
    decode({ ...original, ownerPrincipalId: id.principal("foreign") })
  );
  assert.throws(() =>
    decode({
      ...original,
      content: { ...original.content, text: "x".repeat(2001) },
    })
  );
  assert.throws(() =>
    decode({
      ...original,
      source: { ...source, channelId: "optional-bag-field" },
    })
  );
});

for (const [kind, maximum] of [
  ["web", 16_000],
  ["slack", 16_000],
  ["savedtimer", 32_000],
  ["teamreport", 2000],
] as const) {
  test(`${kind} input preserves its ${maximum}-character boundary`, async () => {
    const original = await event();
    let origin: BotEvent["source"] = source;
    if (kind === "web") {
      origin = { kind, operationId: id.operation("web-input") };
    }
    if (kind === "slack") {
      origin = {
        kind,
        eventId: "slack-event",
        thread: {
          workspaceId: "workspace",
          channelId: "D123",
          rootTimestamp: "123.456000",
        },
      };
    }
    if (kind === "savedtimer") {
      origin = { kind, scheduleId: "saved-schedule", occurrenceId: "123" };
    }
    const input = {
      ...original,
      source: origin,
      id: await botEventId(coordinator, origin),
      content: { text: "x".repeat(maximum), reference: null },
    };
    const decode = Schema.decodeUnknownSync(BotEventSchema, {
      onExcessProperty: "error",
    });
    assert.equal(decode(input).content.text.length, maximum);
    assert.throws(() =>
      decode({
        ...input,
        content: { ...input.content, text: `${input.content.text}x` },
      })
    );
  });
}
