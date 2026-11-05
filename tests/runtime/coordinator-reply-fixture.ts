import assert from "node:assert/strict";
import { registerHooks } from "node:module";

import { Schema } from "effect";

import {
  BotEventSchema,
  BotEventSourceSchema,
  botEventId,
} from "../../packages/contracts/src/bot-events.ts";
import type { BotEvent } from "../../packages/contracts/src/bot-events.ts";
import { RoutedEventAdmissionSchema } from "../../packages/contracts/src/bot-routing.ts";
import { Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { SlackReplyDestinationSchema } from "../../packages/contracts/src/slack-events.ts";
import { BotEventReceipts } from "../../packages/runtime/src/coordinator-event-state.ts";
import { CoordinatorReplies } from "../../packages/runtime/src/coordinator-replies.ts";
import { context } from "./coordinator-fixture.ts";
import { actor, setupWeb } from "./coordinator-web-fixture.ts";
import { waitFor } from "./helpers.ts";

const hooks = registerHooks({
  resolve(specifier, importContext, nextResolve) {
    try {
      return nextResolve(specifier, importContext);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ERR_MODULE_NOT_FOUND" &&
        specifier.startsWith(".")
      ) {
        return nextResolve(`${specifier}.ts`, importContext);
      }
      throw error;
    }
  },
});
const { deliverSlackMessage } =
  await import("../../packages/channels/src/slack-replies.ts");
hooks.deregister();

export const setupReplies = async (team = false) => {
  let linked = true;
  let beforePost: (() => Promise<void>) | undefined;
  let loseSentOutcome = false;
  const posted: { text: string; channel: string; threadTs?: string }[] = [];
  const outcomes: ("sent" | "unknown" | "retry" | "failed")[] = [];
  const sourceIds = new Set([id.source("source-A")]);
  const toolIds = new Set<string>();
  const subject = await setupWeb(
    team,
    "web",
    true,
    (configuration) => ({
      ...configuration,
      checkImportedDependencies: configuration.checkDependencies,
      contentDependencies: () =>
        Promise.resolve({ sourceIds: [...sourceIds], toolIds: [...toolIds] }),
      importDependencies: (dependencies) => {
        for (const sourceId of dependencies.sourceIds) {
          sourceIds.add(sourceId);
        }
        for (const toolId of dependencies.toolIds) {
          toolIds.add(toolId);
        }
      },
      eventReplies: {
        destination: (event) =>
          Promise.resolve(
            Schema.decodeUnknownSync(SlackReplyDestinationSchema)({
              source: event.coordinator,
              ownerPrincipalId: event.ownerPrincipalId,
              authority: {
                appId: "app-A",
                eventId:
                  event.source.kind === "slack"
                    ? event.source.eventId
                    : "invalid",
                userId: "slack-A",
                thread:
                  event.replyTo?.kind === "slack" ? event.replyTo.thread : null,
              },
            })
          ),
        authorize: () =>
          linked
            ? Promise.resolve()
            : Promise.reject(
                new Denied({ code: "revoked", reason: "Slack link changed." })
              ),
        deliver: async (input) => {
          await deliverSlackMessage({
            message: { key: input.key, text: input.text },
            thread: {
              channelId: input.destination.authority.thread.channelId,
              threadTs: input.destination.authority.thread.rootTimestamp,
              conversationId: input.destination.source.conversationId,
            },
            store: {
              get: input.store.get,
              set: (key, delivery) => {
                if (delivery.state === "sent" && loseSentOutcome) {
                  loseSentOutcome = false;
                  return Promise.reject(
                    new Error(
                      "Interrupted before recording the confirmed post."
                    )
                  );
                }
                return input.store.set(key, delivery);
              },
            },
            beforePost: async () => {
              await beforePost?.();
              try {
                await input.beforePost();
                return true;
              } catch (error) {
                if (error instanceof Denied) {
                  return false;
                }
                throw error;
              }
            },
            slack: {
              send: (message) => {
                posted.push(message);
                const state = outcomes.shift() ?? "sent";
                if (state === "sent") {
                  return Promise.resolve({
                    state,
                    ts: `posted-${posted.length}`,
                  });
                }
                if (state === "failed") {
                  return Promise.resolve({ state, error: "rejected" });
                }
                return Promise.resolve({ state });
              },
              edit: () =>
                Promise.reject(
                  new Error(
                    "Exact event replies must not edit unrelated messages."
                  )
                ),
              sendEphemeral: () =>
                Promise.reject(new Error("No ephemeral reply expected.")),
            },
          });
        },
      },
    }),
    1
  );
  const event = async (
    eventId: string,
    text: string,
    rootTimestamp = "1800000000.000001"
  ): Promise<BotEvent> => {
    const source = Schema.decodeUnknownSync(BotEventSourceSchema)({
      kind: "slack",
      eventId,
      thread: { workspaceId: "workspace-A", channelId: "D-A", rootTimestamp },
    });
    return Schema.decodeUnknownSync(BotEventSchema)({
      version: 1,
      id: await botEventId(subject.source.address, source),
      coordinator: subject.source.address,
      ownerPrincipalId: actor.actor.id,
      source,
      replyTo: {
        kind: "slack",
        thread: "thread" in source ? source.thread : null,
      },
      content: { text, reference: null },
      dependencies: { sourceIds: [], toolIds: [] },
    });
  };
  const admit = (value: BotEvent) =>
    subject.events.admit(
      Schema.decodeUnknownSync(RoutedEventAdmissionSchema)({
        version: 2,
        kind: "event-admission",
        event: value,
        routing:
          value.content.text === "status" || value.content.text === "stop"
            ? { kind: "local-control", action: value.content.text }
            : { kind: "automatic" },
      }),
      actor
    );
  const settled = async (value: BotEvent) => {
    const saved = await subject.fixture
      .pi()
      .snapshot(BotEventReceipts, value.id, context);
    assert.ok(saved?.receipt);
    if (saved.receipt.delivery.kind === "coordinator") {
      await subject.fixture
        .pi()
        .waitForTask(saved.receipt.delivery.taskId, context);
    }
    const ready = await waitFor(
      () =>
        subject.fixture.pi().snapshot(CoordinatorReplies, value.id, context),
      (result) => result?.record !== null && result?.record !== undefined
    );
    assert.ok(ready?.record);
    if (ready.record.taskId !== null) {
      await subject.fixture.pi().waitForTask(ready.record.taskId, context);
    }
    const completed = await subject.fixture
      .pi()
      .snapshot(CoordinatorReplies, value.id, context);
    assert.ok(completed?.record);
    return completed.record;
  };
  return {
    ...subject,
    event,
    admit,
    settled,
    posted,
    outcomes,
    loseSentOutcome: () => {
      loseSentOutcome = true;
    },
    setLinked: (value: boolean) => {
      linked = value;
    },
    beforePost: (operation: typeof beforePost) => {
      beforePost = operation;
    },
  };
};
