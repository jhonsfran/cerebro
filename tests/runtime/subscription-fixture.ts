import assert from "node:assert/strict";

import { Schema } from "effect";

import {
  TriggerAdmissionSchema,
  TriggerOriginSchema,
  TriggerSchema,
  triggerId,
} from "../../packages/contracts/src/triggers.ts";
import type { Trigger } from "../../packages/contracts/src/triggers.ts";
import type { SlackThread } from "../../packages/contracts/src/work.ts";
import { fauxAssistantMessage } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { WorkLedger } from "../../packages/runtime/src/coordinator-ledger.ts";
import type { setup } from "./coordinator-fixture.ts";
import { actor, context } from "./coordinator-fixture.ts";

export { actor, context, setup } from "./coordinator-fixture.ts";
export type SubscriptionFixture = Awaited<ReturnType<typeof setup>>;
export const eventFor = async (
  fixture: SubscriptionFixture,
  eventId: string,
  name = "a",
  thread?: SlackThread,
  text = "A realistic follow-up constraint."
): Promise<Trigger & { origin: { kind: "slack"; thread: SlackThread } }> => {
  const source = fixture.source(name);
  const origin = Schema.decodeUnknownSync(TriggerOriginSchema)({
    kind: "slack",
    eventId,
    thread: thread ?? source.thread,
  });
  assert.ok(origin.kind === "slack");
  const trigger = Schema.decodeUnknownSync(TriggerSchema)({
    version: 2,
    id: await triggerId(source.address, origin),
    address: source.address,
    ownerPrincipalId: actor.actor.id,
    origin,
    text,
    reference: null,
    reply: {
      kind: "slack",
      authority: {
        appId: "app-A",
        eventId,
        userId: "slack-A",
        thread: origin.thread,
      },
      ownerPrincipalId: actor.actor.id,
      source: source.address,
    },
    dependencies: { sourceIds: [], toolIds: [] },
  });
  return { ...trigger, origin };
};
export const automatic = (trigger: Trigger) =>
  Schema.decodeUnknownSync(TriggerAdmissionSchema)({
    version: 3,
    kind: "trigger-admission",
    trigger,
    routing: { kind: "automatic" },
  });
export const admit = async (
  fixture: SubscriptionFixture,
  trigger: Trigger,
  name = "a"
) => {
  fixture
    .source(name)
    .faux.setResponses([
      fauxAssistantMessage("The coordinator received the event."),
    ]);
  const receipt = await fixture.triggers().admit(automatic(trigger), actor);
  if (receipt.route.kind === "inbox") {
    await fixture.settled(trigger.id);
  }
  if (await fixture.pi().snapshot(WorkLedger, context)) {
    await fixture.waitDispatch();
  }
  return await fixture.triggers().read(trigger.id, actor);
};
export const start = async (
  fixture: SubscriptionFixture,
  goal: string,
  name = "a"
) => {
  const result = await fixture.invoke(
    name,
    "start_team",
    { goal },
    `start-${name}-${goal}`
  );
  assert.equal(result.settled.status, "done");
  await fixture.waitDispatch();
  return await fixture.work(name);
};
export const subscribe = async (
  fixture: SubscriptionFixture,
  workId: string,
  eventId: string,
  name = "a",
  remove = false
) => {
  const result = await fixture.invoke(
    name,
    remove ? "unsubscribe_work" : "subscribe_work",
    { workId, eventId },
    `subscription-${crypto.randomUUID()}`
  );
  assert.equal(result.settled.status, "done");
  assert.ok(
    result.snapshot.messages.some(
      (message) =>
        message.role === "tool" &&
        message.text.includes(`"subscribed":${!remove}`)
    ),
    JSON.stringify(result.snapshot.messages)
  );
};
