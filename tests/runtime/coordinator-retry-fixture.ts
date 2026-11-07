import assert from "node:assert/strict";

import { Schema } from "effect";

import { createSlackApi } from "../../packages/channels/src/slack-api.ts";
import { deliverSlackMessage } from "../../packages/channels/src/slack-replies.ts";
import {
  TriggerOriginSchema,
  TriggerSchema,
  triggerId,
} from "../../packages/contracts/src/triggers.ts";
import { appendPassiveAnswer } from "../../packages/runtime/src/passive-history.ts";
import { Replies, createReplies } from "../../packages/runtime/src/replies.ts";
import { context, setup } from "./coordinator-fixture.ts";

export const setupRetry = async () => {
  const fixture = await setup();
  const responses: Response[] = [];
  const calls: { at: number; text: string }[] = [];
  const progress: Promise<unknown>[] = [];
  const transport = createSlackApi(
    {
      workspaceId: "T-A",
      appId: "app-A",
      agentId: "coordinator-A",
      signingSecret: "unused",
      botToken: "fixture",
    },
    () =>
      Promise.resolve(
        responses.shift() ?? Response.json({ ok: true, ts: "1.000001" })
      )
  );
  const slack = {
    ...transport,
    send: (message: Parameters<typeof transport.send>[0]) => {
      calls.push({ at: Date.now(), text: message.text });
      return transport.send(message);
    },
  };
  const install = () => {
    const replies = createReplies({
      pi: fixture.pi(),
      persist: () => Promise.resolve(),
      resolve: () =>
        Promise.resolve({
          authorize: () => Promise.resolve(),
          ports: {
            slack: {
              authorize: () => Promise.resolve(),
              deliver: async ({ destination, key, text, store }) => {
                await deliverSlackMessage({
                  message: { key, text },
                  thread: {
                    channelId: destination.authority.thread.channelId,
                    threadTs: destination.authority.thread.rootTimestamp,
                    conversationId: destination.source.conversationId,
                  },
                  store,
                  slack,
                });
              },
            },
          },
        }),
      waitUntil: (promise) => {
        progress.push(
          (async () => {
            try {
              return await promise;
            } catch (error) {
              return error;
            }
          })()
        );
      },
    });
    fixture
      .registry()
      .install({ name: "retry.replies", tasks: [replies.definition] });
    return replies;
  };
  let replies = install();
  return {
    fixture,
    calls,
    responses,
    hold: (name?: string) =>
      replies.hold(
        name === undefined ? undefined : fixture.source(name).native.id
      ),
    enqueue: async (eventId: string, name = "a", savedRetryAt?: number) => {
      const source = fixture.source(name);
      const origin = Schema.decodeUnknownSync(TriggerOriginSchema)({
        kind: "slack",
        eventId,
        thread: source.thread,
      });
      const trigger = Schema.decodeUnknownSync(TriggerSchema)({
        version: 2,
        id: await triggerId(source.address, origin),
        address: source.address,
        ownerPrincipalId: source.ownerPrincipalId,
        origin,
        text: "status",
        reference: null,
        reply: {
          kind: "slack",
          authority: {
            appId: "app-A",
            eventId,
            userId: "slack-A",
            thread: source.thread,
          },
          ownerPrincipalId: source.ownerPrincipalId,
          source: source.address,
        },
        dependencies: { sourceIds: [], toolIds: [] },
      });
      await fixture.pi().commit(async (tx) => {
        await appendPassiveAnswer(
          tx,
          source.native.id,
          "The team has no active work.",
          source.faux.getModel()
        );
        await replies.enqueueIn(tx, {
          trigger,
          nativeId: source.native.id,
          text: "The team has no active work.",
          dependencies: { sourceIds: [], toolIds: [] },
          blocked: false,
        });
        if (savedRetryAt !== undefined) {
          const saved = await tx.doc(Replies, trigger.id, null);
          assert.ok(saved.record);
          saved.record.delivery = {
            state: "retry",
            text: saved.record.text,
            retryAt: savedRetryAt,
          };
        }
      }, context);
      fixture.pi().resume();
      return trigger;
    },
    read: async (triggerIdValue: string) => {
      const saved = await fixture
        .pi()
        .snapshot(Replies, triggerIdValue, context);
      assert.ok(saved?.record);
      return saved.record;
    },
    restart: async () => {
      await fixture.reopen();
      replies = install();
    },
    close: async () => {
      await fixture.close();
      await Promise.allSettled(progress);
    },
  };
};
