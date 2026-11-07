import assert from "node:assert/strict";
import { registerHooks } from "node:module";

import { Schema } from "effect";

import { Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import {
  TriggerOriginSchema,
  TriggerSchema,
  triggerId,
} from "../../packages/contracts/src/triggers.ts";
import type { Trigger } from "../../packages/contracts/src/triggers.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { Replies } from "../../packages/runtime/src/replies.ts";
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

export const replyCall = (eventId: string, text: string, callId?: string) =>
  fauxAssistantMessage(
    fauxToolCall(
      "reply_event",
      { eventId, text },
      callId ? { id: callId } : {}
    ),
    { stopReason: "toolUse" }
  );

export const setupReplies = async (team = false) => {
  let linked = true;
  let beforePost: (() => Promise<void>) | undefined;
  let loseSentOutcome = false;
  const posted: { text: string; channel: string; threadTs?: string }[] = [];
  const outcomes: ("sent" | "unknown" | "retry" | "failed")[] = [];
  const sourceIds = new Set([id.source("source-A")]);
  const toolIds = new Set<string>();
  const subject = await setupWeb(team, true, (configuration) => ({
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
    replyPorts: {
      slack: {
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
                  new Error("Trigger replies must not edit unrelated messages.")
                ),
              sendEphemeral: () =>
                Promise.reject(new Error("No ephemeral reply expected.")),
            },
          });
        },
      },
    },
  }));
  const trigger = async (
    eventId: string,
    text: string,
    rootTimestamp = "1800000000.000001"
  ): Promise<Trigger> => {
    const { address } = subject.source;
    const thread = {
      workspaceId: "workspace-A",
      channelId: "D-A",
      rootTimestamp,
    };
    const origin = Schema.decodeUnknownSync(TriggerOriginSchema)({
      kind: "slack",
      eventId,
      thread,
    });
    return Schema.decodeUnknownSync(TriggerSchema)({
      version: 2,
      id: await triggerId(address, origin),
      address,
      ownerPrincipalId: actor.actor.id,
      origin,
      text,
      reference: null,
      reply: {
        kind: "slack",
        authority: { appId: "app-A", eventId, userId: "slack-A", thread },
        ownerPrincipalId: actor.actor.id,
        source: address,
      },
      dependencies: { sourceIds: [], toolIds: [] },
    });
  };
  const admit = (value: Trigger) =>
    subject.triggers.admit(
      {
        version: 3,
        kind: "trigger-admission",
        trigger: value,
        routing:
          value.text === "status" || value.text === "stop"
            ? { kind: "local-control", action: value.text }
            : { kind: "automatic" },
      },
      actor
    );
  const replied = async (triggerIdValue: string) => {
    const ready = await waitFor(
      () => subject.fixture.pi().snapshot(Replies, triggerIdValue, context),
      (result) => result?.record !== null && result?.record !== undefined,
      10_000,
      10
    );
    assert.ok(ready?.record);
    if (ready.record.taskId !== null) {
      await subject.fixture.pi().waitForTask(ready.record.taskId, context);
    }
    const completed = await subject.fixture
      .pi()
      .snapshot(Replies, triggerIdValue, context);
    assert.ok(completed?.record);
    return completed.record;
  };
  return {
    ...subject,
    trigger,
    admit,
    replied,
    posted,
    outcomes,
    loseSentOutcome: () => {
      loseSentOutcome = true;
    },
    setLinked: (value: boolean) => {
      linked = value;
    },
    beforePost: (operation?: typeof beforePost) => {
      beforePost = operation;
    },
  };
};
