import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { botEventId } from "../../packages/contracts/src/bot-events.ts";
import { RoutedEventAdmissionSchema } from "../../packages/contracts/src/bot-routing.ts";
import {
  Conflict,
  Denied,
  InvalidInput,
  Unavailable,
} from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { TeamEventReturnSchema } from "../../packages/contracts/src/team-events.ts";
import { SlackThreadSchema } from "../../packages/contracts/src/work.ts";
import { fauxAssistantMessage } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  BotEventReceipts,
  eventOf,
} from "../../packages/runtime/src/coordinator-event-state.ts";
import { WorkDocuments } from "../../packages/runtime/src/coordinator-ledger.ts";
import {
  ThreadSubscriptions,
  WorkSubscriptions,
} from "../../packages/runtime/src/coordinator-subscriptions.ts";
import { readImportedContent } from "../../packages/runtime/src/imported-content.ts";
import {
  appendPassiveAnswer,
  appendPassiveUser,
} from "../../packages/runtime/src/passive-history.ts";
import {
  actor,
  admit,
  automatic,
  context,
  eventFor,
  setup,
  start,
  subscribe,
} from "./subscription-fixture.ts";

test("one owned thread routes to two independent works and one work can subscribe to two threads", async () => {
  const fixture = await setup();
  try {
    const first = await start(fixture, "Compare local database options.");
    const second = await start(fixture, "Review event filtering.");
    const seed = await eventFor(fixture, "seed");
    await admit(fixture, seed);
    const other = await eventFor(
      fixture,
      "other-seed",
      "a",
      Schema.decodeUnknownSync(SlackThreadSchema)({
        ...fixture.source("a").thread,
        channelId: "D-other",
      })
    );
    await admit(fixture, other);
    await subscribe(fixture, first.admission.key.workId, seed.id);
    await subscribe(fixture, second.admission.key.workId, seed.id);
    await subscribe(fixture, first.admission.key.workId, other.id);
    const one = await admit(fixture, await eventFor(fixture, "follow-up"));
    assert.equal(one.route.kind, "teams");
    assert.ok(one.route.kind === "teams");
    assert.deepEqual(
      one.route.recipients.map((recipient) => recipient.key.workId).toSorted(),
      [first.admission.key.workId, second.admission.key.workId].toSorted()
    );
    assert.equal(one.delivery.kind, "none");
    const two = await admit(
      fixture,
      await eventFor(
        fixture,
        "other-follow-up",
        "a",
        other.source.kind === "slack" ? other.source.thread : undefined
      )
    );
    assert.ok(two.route.kind === "teams");
    assert.deepEqual(
      two.route.recipients.map((recipient) => recipient.key.workId),
      [first.admission.key.workId]
    );
    assert.equal(fixture.eventSubmissions.length, 2);
    assert.equal(
      fixture.transports.filter((wire) => wire.kind === "event-command").length,
      3
    );
  } finally {
    await fixture.close();
  }
});

test("duplicate admission retains its original recipients after unsubscribe and changed controls conflict", async () => {
  const fixture = await setup();
  try {
    const work = await start(fixture, "Prepare a storage recommendation.");
    const seed = await eventFor(fixture, "seed");
    await admit(fixture, seed);
    await subscribe(fixture, work.admission.key.workId, seed.id);
    const event = await eventFor(fixture, "follow-up");
    const first = await admit(fixture, event);
    await subscribe(fixture, work.admission.key.workId, seed.id, "a", true);
    const count = fixture.transports.length;
    const replay = await fixture.events().admit(automatic(event), actor);
    assert.deepEqual(replay.route, first.route);
    assert.equal(replay.duplicates, 1);
    assert.equal(fixture.transports.length, count);
    await assert.rejects(
      fixture.events().admit(
        Schema.decodeUnknownSync(RoutedEventAdmissionSchema)({
          version: 2,
          kind: "event-admission",
          event,
          routing: {
            kind: "control",
            workId: work.admission.key.workId,
            action: "cancel",
          },
        }),
        actor
      ),
      (error: unknown) => error instanceof Conflict
    );
    const saved = await fixture.work("a");
    assert.equal(saved.status.kind, "accepted");
  } finally {
    await fixture.close();
  }
});

test("web chat has no implicit active-work subscription", async () => {
  const fixture = await setup();
  try {
    await start(fixture, "One task continues.");
    const slack = await eventFor(fixture, "web-operation");
    const source = {
      kind: "web" as const,
      operationId: id.operation("new-topic"),
    };
    const event = {
      ...slack,
      id: await botEventId(slack.coordinator, source),
      source,
      replyTo: { kind: "web" as const, address: slack.coordinator },
    };
    const before = fixture.transports.length;
    const receipt = await admit(fixture, event);
    assert.equal(receipt.route.kind, "coordinator");
    assert.equal(fixture.transports.length, before);
    assert.equal(
      fixture.eventSubmissions.filter((requestId) => requestId === event.id)
        .length,
      1
    );
  } finally {
    await fixture.close();
  }
});

test("queued subscriptions buffer an event without a Team dispatch until promotion", async () => {
  const fixture = await setup();
  try {
    const first = await start(fixture, "First active task.");
    await start(fixture, "Second active task.");
    const queued = await start(fixture, "Third queued task.");
    assert.equal(queued.status.kind, "queued");
    const seed = await eventFor(fixture, "seed");
    await admit(fixture, seed);
    await subscribe(fixture, queued.admission.key.workId, seed.id);
    const receipt = await admit(
      fixture,
      await eventFor(fixture, "queued-update")
    );
    assert.equal(receipt.route.kind, "teams");
    assert.equal(
      fixture.transports.some(
        (wire) =>
          wire.kind === "event-command" &&
          wire.command.work.key.workId === queued.admission.key.workId
      ),
      false
    );
    const saved = await fixture
      .pi()
      .snapshot(WorkDocuments, queued.admission.key.workId, context);
    assert.equal(Object.values(saved?.record?.queuedCommands ?? {}).length, 1);
    await fixture.report(
      "a",
      "release-first",
      undefined,
      first.admission.key.workId
    );
    await fixture.source("a").coordinator.wake();
    await fixture.waitDispatch();
    assert.equal(
      fixture.transports.filter(
        (wire) =>
          wire.kind === "event-command" &&
          wire.command.work.key.workId === queued.admission.key.workId
      ).length,
      1
    );
  } finally {
    await fixture.close();
  }
});

test("queued cancellation marks only that recipient not-delivered and remains exact after reopen", async () => {
  const fixture = await setup();
  try {
    const active = await start(fixture, "Active subscriber.");
    await start(fixture, "Other active work.");
    const queued = await start(fixture, "Queued subscriber.");
    const seed = await eventFor(fixture, "seed");
    await admit(fixture, seed);
    await subscribe(fixture, active.admission.key.workId, seed.id);
    await subscribe(fixture, queued.admission.key.workId, seed.id);
    const event = await eventFor(fixture, "fan-out-before-cancel");
    const original = await admit(fixture, event);
    const inputs = fixture.eventSubmissions.length;
    await fixture.invoke(
      "a",
      "stop_work",
      { workId: queued.admission.key.workId },
      "cancel-queued"
    );
    const after = await fixture.events().read(event.id, actor);
    assert.ok(after.route.kind === "teams");
    assert.deepEqual(
      after.route.recipients.find(
        (recipient) => recipient.key.workId === queued.admission.key.workId
      )?.disposition,
      { kind: "not-delivered", reason: "cancelled" }
    );
    assert.deepEqual(
      after.route.recipients.find(
        (recipient) => recipient.key.workId === active.admission.key.workId
      )?.disposition,
      { kind: "admitted" }
    );
    assert.equal(after.delivery.kind, "none");
    assert.equal(fixture.eventSubmissions.length, inputs);
    assert.equal(
      fixture.transports.some(
        (wire) =>
          wire.kind === "event-command" &&
          wire.command.work.key.workId === queued.admission.key.workId
      ),
      false
    );
    await fixture.reopen();
    const replay = await fixture.events().admit(automatic(event), actor);
    assert.deepEqual(replay.route, after.route);
    assert.equal(replay.delivery.kind, "none");
    await assert.rejects(
      fixture.events().receiveReturn(
        {
          version: 2,
          kind: "event-return",
          work: queued.admission,
          eventId: event.id,
          eventDigest: original.digest,
        },
        actor
      ),
      (error: unknown) => error instanceof Denied
    );
    fixture
      .source("a")
      .faux.setResponses([
        fauxAssistantMessage("The active recipient returned this event."),
      ]);
    await fixture.events().receiveReturn(
      {
        version: 2,
        kind: "event-return",
        work: active.admission,
        eventId: event.id,
        eventDigest: original.digest,
      },
      actor
    );
    const returned = await fixture.events().read(event.id, actor);
    assert.ok(returned.delivery.kind === "coordinator");
    await fixture.pi().waitForTask(returned.delivery.taskId, context);
    assert.equal(
      fixture.eventSubmissions.filter((requestId) => requestId === event.id)
        .length,
      1
    );
  } finally {
    await fixture.close();
  }
});

test("queued expiry saves not-delivered before clearing commands without creating a Team", async () => {
  const fixture = await setup(1000);
  try {
    await start(fixture, "First active.");
    await start(fixture, "Second active.");
    const queued = await start(fixture, "Expiring queued.");
    const seed = await eventFor(fixture, "seed");
    await admit(fixture, seed);
    await subscribe(fixture, queued.admission.key.workId, seed.id);
    const event = await eventFor(fixture, "expiring-follow-up");
    await admit(fixture, event);
    fixture.advance(1001);
    await fixture.source("a").coordinator.wake();
    await fixture.waitDispatch();
    const receipt = await fixture.events().read(event.id, actor);
    assert.ok(receipt.route.kind === "teams");
    assert.deepEqual(receipt.route.recipients[0]?.disposition, {
      kind: "not-delivered",
      reason: "expired",
    });
    assert.equal(receipt.delivery.kind, "none");
    const expired = await fixture
      .pi()
      .snapshot(WorkDocuments, queued.admission.key.workId, context);
    assert.deepEqual(expired?.record?.queuedCommands, {});
    assert.equal(
      fixture.transports.some(
        (wire) =>
          wire.kind === "event-command" &&
          wire.command.work.key.workId === queued.admission.key.workId
      ),
      false
    );
    await fixture.reopen();
    const replay = await fixture.events().admit(automatic(event), actor);
    assert.deepEqual(replay.route, receipt.route);
    assert.equal(
      fixture.eventSubmissions.filter((requestId) => requestId === event.id)
        .length,
      0
    );
  } finally {
    await fixture.close();
  }
});

test("a terminal subscriber does not block a valid subscriber", async () => {
  const fixture = await setup();
  try {
    const first = await start(fixture, "Soon completed.");
    const second = await start(fixture, "Still active.");
    const seed = await eventFor(fixture, "seed");
    await admit(fixture, seed);
    await subscribe(fixture, first.admission.key.workId, seed.id);
    await subscribe(fixture, second.admission.key.workId, seed.id);
    await fixture.report(
      "a",
      "first-done",
      undefined,
      first.admission.key.workId
    );
    const receipt = await admit(
      fixture,
      await eventFor(fixture, "new-follow-up")
    );
    assert.ok(receipt.route.kind === "teams");
    assert.deepEqual(
      receipt.route.recipients.map((recipient) => recipient.key.workId),
      [second.admission.key.workId]
    );
    assert.deepEqual(receipt.route.skipped, [
      { workId: first.admission.key.workId, reason: "terminal" },
    ]);
  } finally {
    await fixture.close();
  }
});

test("terminal references are reclaimed before the live subscription limit", async () => {
  const fixture = await setup();
  try {
    const seed = await eventFor(fixture, "long-lived-thread");
    await admit(fixture, seed);
    const oldIds: string[] = [];
    // oxlint-disable no-await-in-loop -- Each next work starts after the preceding work completes.
    for (const index of Array.from({ length: 8 }, (_, value) => value)) {
      const work = await start(fixture, `Sequential work ${index}.`);
      await subscribe(fixture, work.admission.key.workId, seed.id);
      oldIds.push(work.admission.key.workId);
      await fixture.report(
        "a",
        `completed-${index}`,
        undefined,
        work.admission.key.workId
      );
    }
    // oxlint-enable no-await-in-loop
    const next = await start(fixture, "Ninth live work.");
    await subscribe(fixture, next.admission.key.workId, seed.id);
    const current = await fixture
      .pi()
      .snapshot(WorkSubscriptions, next.admission.key.workId, context);
    assert.equal(current?.record?.threadKeys.length, 1);
    const [key] = current?.record?.threadKeys ?? [];
    assert.ok(key);
    const thread = await fixture
      .pi()
      .snapshot(ThreadSubscriptions, key, context);
    assert.deepEqual(thread?.record?.workIds, [next.admission.key.workId]);
    const reverse = await Promise.all(
      oldIds.map((workId) =>
        fixture.pi().snapshot(WorkSubscriptions, workId, context)
      )
    );
    assert.ok(
      reverse.every((record) => record?.record?.threadKeys.length === 0)
    );
    const [completedId] = oldIds;
    assert.ok(completedId);
    const failed = await fixture.invoke(
      "a",
      "subscribe_work",
      { workId: completedId, eventId: seed.id },
      "cannot-subscribe-completed"
    );
    assert.ok(
      failed.snapshot.messages.some(
        (message) =>
          message.role === "tool" &&
          message.text.includes("Only active or queued work can subscribe")
      )
    );
  } finally {
    await fixture.close();
  }
});

test("live relations stop at eight works per thread and eight threads per work", async () => {
  const fixture = await setup();
  try {
    const seed = await eventFor(fixture, "seed");
    await admit(fixture, seed);
    const works = [];
    // oxlint-disable no-await-in-loop -- Each fixture turn consumes one complete model response sequence.
    for (const index of Array.from({ length: 9 }, (_, value) => value)) {
      const work = await start(fixture, `Live work ${index}.`);
      works.push(work);
      if (index < 8) {
        await subscribe(fixture, work.admission.key.workId, seed.id);
      }
    }
    // oxlint-enable no-await-in-loop
    const last = works.at(-1);
    const [first] = works;
    assert.ok(first && last);
    const denied = await fixture.invoke(
      "a",
      "subscribe_work",
      { workId: last.admission.key.workId, eventId: seed.id },
      "ninth-thread-recipient"
    );
    assert.ok(
      denied.snapshot.messages.some(
        (message) =>
          message.role === "tool" &&
          message.text.includes("at most eight subscriptions")
      )
    );
    assert.equal(
      await fixture
        .pi()
        .snapshot(WorkSubscriptions, last.admission.key.workId, context),
      undefined
    );
    // oxlint-disable no-await-in-loop -- Each admitted reference must exist before its subscription tool turn.
    for (const index of Array.from({ length: 7 }, (_, value) => value)) {
      const thread = Schema.decodeUnknownSync(SlackThreadSchema)({
        ...fixture.source("a").thread,
        channelId: `D-extra-${index}`,
      });
      const reference = await eventFor(fixture, `thread-${index}`, "a", thread);
      await admit(fixture, reference);
      await subscribe(fixture, first.admission.key.workId, reference.id);
    }
    // oxlint-enable no-await-in-loop
    const extra = await eventFor(
      fixture,
      "ninth-thread",
      "a",
      Schema.decodeUnknownSync(SlackThreadSchema)({
        ...fixture.source("a").thread,
        channelId: "D-ninth",
      })
    );
    await admit(fixture, extra);
    await fixture.invoke(
      "a",
      "subscribe_work",
      { workId: first.admission.key.workId, eventId: extra.id },
      "ninth-work-thread"
    );
    const subscriptions = await fixture
      .pi()
      .snapshot(WorkSubscriptions, first.admission.key.workId, context);
    assert.equal(subscriptions?.record?.threadKeys.length, 8);
  } finally {
    await fixture.close();
  }
});

test("one recipient transfer limit does not block another recipient's valid event", async () => {
  const fixture = await setup();
  try {
    fixture.setDependencies({
      sourceIds: [id.source("extra-source")],
      toolIds: [],
    });
    const full = await start(fixture, "Has one extra dependency.");
    fixture.setDependencies({ sourceIds: [], toolIds: [] });
    const fits = await start(fixture, "Fits the incoming dependency set.");
    const seed = await eventFor(fixture, "seed");
    await admit(fixture, seed);
    await subscribe(fixture, full.admission.key.workId, seed.id);
    await subscribe(fixture, fits.admission.key.workId, seed.id);
    const incoming = await eventFor(fixture, "large-dependency-event");
    const event = {
      ...incoming,
      dependencies: {
        sourceIds: Array.from({ length: 512 }, (_, index) =>
          id.source(`incoming-${index}`)
        ),
        toolIds: [],
      },
    };
    const receipt = await admit(fixture, event);
    assert.ok(receipt.route.kind === "teams");
    assert.deepEqual(
      receipt.route.recipients.map((recipient) => recipient.key.workId),
      [fits.admission.key.workId]
    );
    assert.deepEqual(receipt.route.skipped, [
      { workId: full.admission.key.workId, reason: "full" },
    ]);
    const command = fixture.transports.find(
      (wire) => wire.kind === "event-command" && wire.event.id === event.id
    );
    assert.ok(command?.kind === "event-command");
    assert.deepEqual(command.command.contentDependencies, event.dependencies);
    const explicit = await eventFor(fixture, "explicit-overflow");
    await assert.rejects(
      fixture.events().admit(
        {
          version: 2,
          kind: "event-admission",
          event: { ...explicit, dependencies: event.dependencies },
          routing: {
            kind: "control",
            action: "update",
            workId: full.admission.key.workId,
          },
        },
        actor
      ),
      (error: unknown) =>
        error instanceof InvalidInput &&
        error.reason.includes("dependency limit")
    );
  } finally {
    await fixture.close();
  }
});

test("subscription preparation retries a changed relation instead of admitting an unchecked recipient", async () => {
  const fixture = await setup();
  try {
    const first = await start(fixture, "First.");
    const second = await start(fixture, "Second.");
    const seed = await eventFor(fixture, "seed");
    await admit(fixture, seed);
    await subscribe(fixture, first.admission.key.workId, seed.id);
    const event = await eventFor(fixture, "prepared");
    const prepared = await fixture
      .source("a")
      .subscriptions.prepare(automatic(event), actor);
    await subscribe(fixture, second.admission.key.workId, seed.id);
    const count = fixture.transports.length;
    await assert.rejects(
      fixture.pi().commit(prepared, context),
      (error: unknown) => error instanceof Unavailable
    );
    assert.equal(fixture.transports.length, count);
    assert.equal(
      await fixture.pi().snapshot(BotEventReceipts, event.id, context),
      undefined
    );
    const accepted = await admit(fixture, event);
    assert.ok(accepted.route.kind === "teams");
    assert.equal(accepted.route.recipients.length, 2);
  } finally {
    await fixture.close();
  }
});

test("two recipient returns create one coordinator input, preserve authority and leave both works active", async () => {
  const fixture = await setup();
  try {
    const first = await start(fixture, "First.");
    const second = await start(fixture, "Second.");
    const seed = await eventFor(fixture, "seed");
    await admit(fixture, seed);
    await subscribe(fixture, first.admission.key.workId, seed.id);
    await subscribe(fixture, second.admission.key.workId, seed.id);
    const event = await eventFor(
      fixture,
      "unrelated",
      "a",
      undefined,
      "What time does the planning meeting begin?"
    );
    const receipt = await admit(fixture, event);
    assert.ok(receipt.route.kind === "teams");
    const returned = (work: typeof first) =>
      Schema.decodeUnknownSync(TeamEventReturnSchema)({
        version: 2,
        kind: "event-return",
        work: work.admission,
        eventId: event.id,
        eventDigest: receipt.digest,
      });
    fixture
      .source("a")
      .faux.setResponses([
        fauxAssistantMessage(
          "The coordinator handles this unrelated question."
        ),
      ]);
    await Promise.all([
      fixture.events().receiveReturn(returned(first), actor),
      fixture.events().receiveReturn(returned(second), actor),
    ]);
    const saved = await fixture.events().read(event.id, actor);
    assert.ok(saved.delivery.kind === "coordinator");
    await fixture.pi().waitForTask(saved.delivery.taskId, context);
    const completed = await fixture.events().read(event.id, actor);
    assert.equal(
      fixture.eventSubmissions.filter((requestId) => requestId === event.id)
        .length,
      1
    );
    assert.deepEqual(eventOf(saved), event);
    assert.ok(saved.route.kind === "teams");
    assert.equal(
      saved.route.recipients.filter(
        (recipient) => recipient.disposition.kind === "returned"
      ).length,
      2
    );
    await fixture.events().receiveReturn(returned(first), actor);
    const replay = await fixture.events().read(event.id, actor);
    assert.deepEqual(replay.delivery, completed.delivery);
    const ledger = await fixture.ledger();
    assert.equal(
      ledger.works[first.admission.key.workId]?.status.kind,
      "accepted"
    );
    assert.equal(
      ledger.works[second.admission.key.workId]?.status.kind,
      "accepted"
    );
    assert.equal(Object.keys(ledger.active).length, 2);
  } finally {
    await fixture.close();
  }
});

test("a work that did not receive an event cannot return it", async () => {
  const fixture = await setup();
  try {
    const first = await start(fixture, "Receiver.");
    const other = await start(fixture, "Not subscribed.");
    const seed = await eventFor(fixture, "seed");
    await admit(fixture, seed);
    await subscribe(fixture, first.admission.key.workId, seed.id);
    const event = await eventFor(fixture, "follow-up");
    const receipt = await admit(fixture, event);
    await assert.rejects(
      fixture.events().receiveReturn(
        {
          version: 2,
          kind: "event-return",
          work: other.admission,
          eventId: event.id,
          eventDigest: receipt.digest,
        },
        actor
      ),
      (error: unknown) => error instanceof Denied
    );
    const saved = await fixture.events().read(event.id, actor);
    assert.equal(saved.delivery.kind, "none");
  } finally {
    await fixture.close();
  }
});

test("an unadmitted event reference cannot create a subscription", async () => {
  const fixture = await setup();
  try {
    const work = await start(fixture, "Target.");
    await fixture.invoke(
      "a",
      "subscribe_work",
      { workId: work.admission.key.workId, eventId: "unadmitted-event" },
      "unknown-reference"
    );
    assert.equal(
      await fixture
        .pi()
        .snapshot(WorkSubscriptions, work.admission.key.workId, context),
      undefined
    );
  } finally {
    await fixture.close();
  }
});

test("two bots can explicitly subscribe through one owned thread reference without copying its content", async () => {
  const fixture = await setup();
  try {
    fixture.setDependencies({ sourceIds: [], toolIds: [] });
    const first = await start(fixture, "Bot A work.");
    const second = await start(fixture, "Bot B work.", "b");
    const seed = await eventFor(
      fixture,
      "shared-seed",
      "a",
      undefined,
      "ORIGINAL_PRIVATE_BODY_MUST_NOT_COPY"
    );
    await admit(fixture, seed);
    await subscribe(fixture, first.admission.key.workId, seed.id);
    await subscribe(fixture, second.admission.key.workId, seed.id, "b");
    const sources = await fixture
      .events()
      .listSubscribedBotSources(fixture.source("a").thread, actor);
    assert.deepEqual(
      sources.map((source) => source.agentId).toSorted(),
      [
        fixture.source("a").address.agentId,
        fixture.source("b").address.agentId,
      ].toSorted()
    );
    assert.equal(
      JSON.stringify(
        await fixture.source("b").native.context(context)
      ).includes("ORIGINAL_PRIVATE_BODY_MUST_NOT_COPY"),
      false
    );
    assert.deepEqual(
      await readImportedContent(fixture.pi(), fixture.source("b").native.id),
      { sourceIds: [], toolIds: [] }
    );
    const eventA = await eventFor(fixture, "shared-next", "a");
    const eventB = await eventFor(
      fixture,
      "shared-next",
      "b",
      fixture.source("a").thread
    );
    const receipts = await Promise.all([
      admit(fixture, eventA),
      admit(fixture, eventB, "b"),
    ]);
    assert.notEqual(eventA.id, eventB.id);
    assert.deepEqual(
      receipts.map((receipt) => receipt.route.kind),
      ["teams", "teams"]
    );
    fixture.revoke("a");
    const eligible = await fixture
      .events()
      .listSubscribedBotSources(fixture.source("a").thread, actor);
    assert.deepEqual(
      eligible.map((source) => source.agentId),
      [fixture.source("b").address.agentId]
    );
  } finally {
    await fixture.close();
  }
});

test("cross-bot subscription requires current access to the original source and target work", async () => {
  const fixture = await setup();
  try {
    const target = await start(fixture, "Bot B work.", "b");
    const seed = await eventFor(fixture, "source-A");
    await admit(fixture, seed);
    fixture.revoke("a");
    await fixture.invoke(
      "b",
      "subscribe_work",
      { workId: target.admission.key.workId, eventId: seed.id },
      "denied-original"
    );
    assert.equal(
      await fixture
        .pi()
        .snapshot(WorkSubscriptions, target.admission.key.workId, context),
      undefined
    );
  } finally {
    await fixture.close();
  }
});

test("local controls save one exact passive answer with no native submission", async () => {
  const fixture = await setup();
  try {
    const source = fixture.source("a");
    fixture.setLocalControl((event, action) =>
      Promise.resolve(async (tx) => {
        await appendPassiveUser(tx, source.native.id, event.content.text);
        const answer = await appendPassiveAnswer(
          tx,
          source.native.id,
          `Local ${action} answer.`,
          source.faux.getModel()
        );
        return { kind: "local-answer", action, answerEntryId: answer.id };
      })
    );
    const event = await eventFor(
      fixture,
      "local-status",
      "a",
      undefined,
      "status"
    );
    const input = Schema.decodeUnknownSync(RoutedEventAdmissionSchema)({
      version: 2,
      kind: "event-admission",
      event,
      routing: { kind: "local-control", action: "status" },
    });
    const one = await fixture.events().admit(input, actor);
    const two = await fixture.events().admit(input, actor);
    assert.equal(one.route.kind, "local-answer");
    assert.deepEqual(two.route, one.route);
    assert.equal(one.delivery.kind, "none");
    assert.equal(fixture.eventSubmissions.length, 0);
    assert.equal(
      await fixture
        .pi()
        .commit(
          (tx) => tx.submissionByRequest(source.native.id, event.id),
          context
        ),
      undefined
    );
    assert.ok(one.route.kind === "local-answer");
    const entries = await source.native.entries(
      {
        minEntryId: one.route.answerEntryId,
        maxEntryId: one.route.answerEntryId,
      },
      1,
      undefined,
      context
    );
    assert.match(JSON.stringify(entries.items), /Local status answer\./u);
    assert.throws(() =>
      Schema.decodeUnknownSync(RoutedEventAdmissionSchema)({
        ...input,
        routing: { kind: "local-control", action: "stop" },
      })
    );
  } finally {
    await fixture.close();
  }
});

test("command and return receipts recover after reopen without another route or answer", async () => {
  const fixture = await setup();
  try {
    const work = await start(fixture, "Persistent task.");
    const seed = await eventFor(fixture, "seed");
    await admit(fixture, seed);
    await subscribe(fixture, work.admission.key.workId, seed.id);
    const event = await eventFor(fixture, "retained-follow-up");
    const original = await admit(fixture, event);
    const count = fixture.transports.length;
    await fixture.reopen();
    const replay = await fixture.events().admit(automatic(event), actor);
    assert.deepEqual(replay.route, original.route);
    assert.equal(fixture.transports.length, count);
    fixture
      .source("a")
      .faux.setResponses([
        fauxAssistantMessage("Recovered coordinator answer."),
      ]);
    const returned = {
      version: 2,
      kind: "event-return",
      work: work.admission,
      eventId: event.id,
      eventDigest: original.digest,
    };
    await fixture.events().receiveReturn(returned, actor);
    const accepted = await fixture.events().read(event.id, actor);
    assert.ok(accepted.delivery.kind === "coordinator");
    await fixture.pi().waitForTask(accepted.delivery.taskId, context);
    const completed = await fixture.events().read(event.id, actor);
    await fixture.reopen();
    await fixture.events().receiveReturn(returned, actor);
    const restored = await fixture.events().read(event.id, actor);
    assert.deepEqual(restored.delivery, completed.delivery);
    assert.equal(
      fixture.eventSubmissions.filter((requestId) => requestId === event.id)
        .length,
      1
    );
  } finally {
    await fixture.close();
  }
});
