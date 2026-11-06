import assert from "node:assert/strict";
import { before as beforeAll, test } from "node:test";

import { z } from "zod";

import { waitForFixture } from "../../slice-1/application.ts";
import { slackInputEvidence } from "./slack-team-support.ts";
import { queueBodies } from "./team-queue-support.ts";
import {
  configure,
  drained,
  event,
  evidence,
  externalEventKey,
  fixture,
  hasReply,
  literal,
  metadata,
  observed,
  primaryDecision,
  queue,
  send,
  signedCallback,
  slack,
  snapshot,
} from "./team-support.ts";
import { createConversation, read } from "./web-team-support.ts";

let installed: Awaited<ReturnType<typeof configure>>;
beforeAll(
  async () => {
    installed = await configure({ link: false });
  },
  { timeout: 180_000 }
);

test(
  "signed Slack filtering and linking retain ignored decisions without model work",
  { timeout: 180_000 },
  async () => {
    const before = await observed();
    const unlinked = event(
      "filter-unlinked",
      "This input must stay ignored after linking.",
      "1800010000.000001"
    );
    const bot = event(
      "filter-bot",
      "Do not execute bot noise.",
      "1800010001.000001"
    );
    const subtype = event(
      "filter-subtype",
      "Do not execute changed messages.",
      "1800010002.000001"
    );
    const unsupported = event(
      "filter-unsupported",
      "Do not execute reactions.",
      "1800010003.000001"
    );
    const invalid = await signedCallback(
      event("filter-invalid", "Invalid signature.", "1800010004.000001"),
      { invalidSignature: true }
    );
    assert.equal(invalid.status, 401);
    await invalid.body?.cancel();
    const expired = await signedCallback(
      event("filter-expired", "Expired callback.", "1800010005.000001"),
      { timestamp: String(Math.floor(Date.now() / 1000) - 600) }
    );
    assert.equal(expired.status, 401);
    await expired.body?.cancel();
    await Promise.all([
      send(unlinked),
      send({ ...bot, event: { ...bot.event, bot_id: "native-bot" } }),
      send({
        ...subtype,
        event: { ...subtype.event, subtype: "message_changed" },
      }),
      send({
        ...unsupported,
        event: { ...unsupported.event, type: "reaction_added" },
      }),
    ]);
    const reason = await waitForFixture(
      () =>
        fixture.sql(
          `SELECT decision->>'reason' FROM channel_slack_event_receipt WHERE event_key=${literal(externalEventKey(unlinked.event_id))}`
        ),
      (value) => value === "unlinked"
    );
    await drained("cerebro-slack-events");
    const noise = await observed();
    assert.equal(noise.model.length, before.model.length);
    assert.equal(
      await fixture.sql(
        `SELECT count(*) FROM channel_slack_event_receipt WHERE event_key IN (${[externalEventKey("filter-invalid"), externalEventKey("filter-expired")].map(literal).join(",")})`
      ),
      "0"
    );
    const link = await fixture.json(
      "/rpc/identity/beginSlackLink",
      metadata.owner.cookie,
      z.object({ json: z.object({ code: z.string() }) }),
      { json: { organizationId: metadata.agent.organizationId } }
    );
    await send(
      event("filter-link", `link ${link.json.code}`, "1800010010.000001")
    );
    await waitForFixture(
      () =>
        fixture.sql(
          `SELECT principal_id FROM identity_slack_link WHERE workspace_id=${literal(slack.workspaceId)} AND slack_user_id='native-team-user'`
        ),
      (value) => value === metadata.agent.principalId
    );
    await send(unlinked, true);
    await drained("cerebro-slack-events");
    assert.equal(
      await fixture.sql(
        `SELECT decision->>'reason' FROM channel_slack_event_receipt WHERE event_key=${literal(externalEventKey(unlinked.event_id))}`
      ),
      "unlinked"
    );
    const afterLink = await observed();
    assert.equal(afterLink.model.length, before.model.length);
    await evidence("native-slack-filter-link", {
      before,
      noise,
      reason,
      eventId: unlinked.event_id,
    });
  }
);

test(
  "identical signed callbacks share one frozen primary event and changed content conflicts at the actual consumer",
  { timeout: 240_000 },
  async () => {
    const thread = "1800010100.000001";
    const input = event(
      "filter-exact-callback",
      "Give one brief answer about the planning meeting.",
      thread
    );
    const opened = await createConversation(installed.coordinator.agentId);
    const baseline = await read(opened.route);
    const messageIds = new Set(
      baseline.snapshot.messages.map((message) => message.id)
    );
    const before = await observed();
    await Promise.all([send(input), send(input, true)]);
    const saved = await primaryDecision(input.event_id);
    const physical = await waitForFixture(
      observed,
      (value) =>
        value.model.length === before.model.length + 1 &&
        hasReply(value, thread, "Cerebro slice 1 completed."),
      60_000
    );
    const view = await snapshot(input.event_id, installed.coordinator.agentId);
    const admitted = await slackInputEvidence({
      admitted: view,
      before,
      physical,
      requestCount: 1,
      answer: "Cerebro slice 1 completed.",
    });
    assert.equal(
      view.snapshot.messages.filter(
        (message) =>
          !messageIds.has(message.id) &&
          message.role === "user" &&
          message.text === input.event.text
      ).length,
      0
    );
    assert.equal(saved.decision.targets.length, 1);
    assert.deepEqual(saved.decision.targets[0], view.target);
    assert.equal(
      await fixture.sql(
        `SELECT kind FROM channel_conversation WHERE conversation_id=${literal(view.conversationId)}`
      ),
      "web"
    );
    await send(input, true);
    await drained("cerebro-slack-events");
    const replayPhysical = await observed();
    assert.equal(replayPhysical.model.length, physical.model.length);
    const changed = {
      ...input,
      event: {
        ...input.event,
        text: "Changed content under the same provider event identity.",
      },
    };
    await send(changed, true);
    const conflict = await waitForFixture(
      () => queue("peek", "cerebro-slack-events-dead-letter", 20),
      (value) =>
        queueBodies(value).some((body) => {
          const row = z
            .object({
              eventId: z.string(),
              organizationId: z.string(),
              appId: z.string(),
              workspaceId: z.string(),
              event: z.object({ text: z.string() }),
            })
            .parse(body);
          return (
            row.eventId === input.event_id &&
            row.organizationId === metadata.agent.organizationId &&
            row.appId === slack.appId &&
            row.workspaceId === slack.workspaceId &&
            row.event.text === changed.event.text
          );
        }),
      180_000
    );
    assert.deepEqual(await primaryDecision(input.event_id), saved);
    const retained = await snapshot(
      input.event_id,
      installed.coordinator.agentId
    );
    assert.deepEqual(retained.snapshot, view.snapshot);
    const after = await observed();
    assert.equal(after.model.length, physical.model.length);
    assert.equal(
      after.slack.messages.filter(
        (message) =>
          message.threadTs === thread &&
          message.text === "Cerebro slice 1 completed."
      ).length,
      1
    );
    await evidence("native-slack-exact-digest", {
      input,
      saved,
      physical,
      view,
      baseline,
      admitted,
      changed,
      conflict,
      after,
    });
  }
);
