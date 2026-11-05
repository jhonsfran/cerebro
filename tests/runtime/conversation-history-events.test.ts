import assert from "node:assert/strict";
import { test } from "node:test";

import { botEventId } from "../../packages/contracts/src/bot-events.ts";
import type { BotEvent } from "../../packages/contracts/src/bot-events.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { searchConversationHistory } from "../../packages/runtime/src/conversation-history.ts";
import type { HistoryScope } from "../../packages/runtime/src/conversation-history.ts";
import { BotEventReceipts } from "../../packages/runtime/src/coordinator-event-state.ts";
import { context } from "./coordinator-fixture.ts";
import { actor, setupWeb } from "./coordinator-web-fixture.ts";

type Subject = Awaited<ReturnType<typeof setupWeb>>;
const derived = () => [
  fauxAssistantMessage(
    fauxToolCall("search_history", { question: "Find earlier evidence." }),
    { stopReason: "toolUse" }
  ),
  fauxAssistantMessage("SEARCH_TOKEN derived child answer."),
  fauxAssistantMessage("SEARCH_TOKEN derived parent answer."),
];
const settle = async (subject: Subject, eventId: string) => {
  const saved = await subject.fixture
    .pi()
    .snapshot(BotEventReceipts, eventId, context);
  assert.ok(saved?.receipt?.delivery.kind === "coordinator");
  await subject.fixture
    .pi()
    .waitForTask(saved.receipt.delivery.taskId, context);
  const completed = await subject.fixture
    .pi()
    .snapshot(BotEventReceipts, eventId, context);
  assert.ok(
    completed?.receipt?.delivery.kind === "coordinator" &&
      completed.receipt.delivery.admission.kind === "settled" &&
      completed.receipt.delivery.admission.outcome === "done"
  );
  return completed.receipt.delivery.admission;
};
const send = async (subject: Subject, operationId: string, text: string) => {
  const response = await subject.send(operationId, text);
  assert.equal(response.status, 200, await response.clone().text());
  const eventId = await botEventId(subject.source.address, {
    kind: "web",
    operationId: id.operation(operationId),
  });
  return await settle(subject, eventId);
};
const search = async (subject: Subject, term: string) => {
  const source: HistoryScope = {
    native: subject.source.native,
    runtime: subject.scope.runtime,
    read: (caller, signal) => subject.scope.read(caller, signal),
  };
  return await searchConversationHistory(
    {
      target: source,
      addresses: [subject.source.address],
      open: () => Promise.resolve(source),
      metadata: (operation) => subject.fixture.pi().commit(operation, context),
      persist: () => Promise.resolve(),
    },
    term
  );
};

test("history search returns original web event evidence with its saved native citation", async () => {
  const subject = await setupWeb();
  try {
    subject.source.faux.setResponses([
      fauxAssistantMessage("The note is saved."),
    ]);
    const admitted = await send(
      subject,
      "original-web-note",
      "CAP_SEARCH_TOKEN ALLOW_ONLY_123"
    );
    const entry = await subject.fixture
      .pi()
      .commit((tx) => tx.entry(admitted.entry), context);
    assert.equal(entry?.kind, "cerebro.bot-event-input");
    assert.deepEqual(entry?.data, {
      eventId: admitted.requestId,
      source: "web",
      operationId: "original-web-note",
      agentVersion: 1,
      policyVersion: 0,
    });
    assert.deepEqual(await search(subject, "CAP_SEARCH_TOKEN"), {
      matches: [
        {
          conversationId: subject.source.address.conversationId,
          entryId: String(admitted.entry),
          role: "user",
          snippet: "CAP_SEARCH_TOKEN ALLOW_ONLY_123",
        },
      ],
      truncated: false,
    });
  } finally {
    await subject.close();
  }
});

test("web and hidden event boundaries exclude search-derived turns without discarding original evidence", async () => {
  const subject = await setupWeb();
  try {
    subject.source.faux.setResponses(derived());
    await send(
      subject,
      "derived-web-note",
      "SEARCH_TOKEN derived web request."
    );
    subject.source.faux.setResponses([
      fauxAssistantMessage("The original note is saved."),
    ]);
    const before = await send(
      subject,
      "before-hidden",
      "SEARCH_TOKEN ORIGINAL_BEFORE_HIDDEN"
    );
    const source = {
      kind: "slack",
      eventId: "hidden-slack-source",
      thread: subject.source.thread,
    } as const;
    const event: BotEvent = {
      version: 1,
      id: await botEventId(subject.source.address, source),
      coordinator: subject.source.address,
      ownerPrincipalId: actor.actor.id,
      source,
      replyTo: null,
      content: { text: "SEARCH_TOKEN HIDDEN_SLACK_INPUT", reference: null },
      dependencies: { sourceIds: [], toolIds: [] },
    };
    subject.source.faux.setResponses(derived());
    await subject.events.admit(event, actor);
    await settle(subject, event.id);
    subject.source.faux.setResponses([
      fauxAssistantMessage("The later note is saved."),
    ]);
    const after = await send(
      subject,
      "after-hidden",
      "SEARCH_TOKEN ALLOW_ONLY_123"
    );
    assert.deepEqual(await search(subject, "SEARCH_TOKEN"), {
      matches: [
        {
          conversationId: subject.source.address.conversationId,
          entryId: String(after.entry),
          role: "user",
          snippet: "SEARCH_TOKEN ALLOW_ONLY_123",
        },
        {
          conversationId: subject.source.address.conversationId,
          entryId: String(before.entry),
          role: "user",
          snippet: "SEARCH_TOKEN ORIGINAL_BEFORE_HIDDEN",
        },
      ],
      truncated: false,
    });
  } finally {
    await subject.close();
  }
});
