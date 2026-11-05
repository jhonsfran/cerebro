import assert from "node:assert/strict";

import { Schema } from "effect";

import { createSlackApi } from "../../packages/channels/src/slack-api.ts";
import { deliverSlackMessage } from "../../packages/channels/src/slack-replies.ts";
import {
  BotEventSchema,
  botEventId,
} from "../../packages/contracts/src/bot-events.ts";
import { SlackReplyDestinationSchema } from "../../packages/contracts/src/slack-events.ts";
import {
  CoordinatorReplies,
  createCoordinatorReplies,
} from "../../packages/runtime/src/coordinator-replies.ts";
import { appendPassiveAnswer } from "../../packages/runtime/src/passive-history.ts";
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
    const replies = createCoordinatorReplies({
      pi: fixture.pi(),
      persist: () => Promise.resolve(),
      resolve: () =>
        Promise.resolve({
          deliverReply: async (record, store) => {
            assert.ok(record.destination);
            await deliverSlackMessage({
              message: { key: record.key, text: record.text },
              thread: {
                channelId: record.destination.authority.thread.channelId,
                threadTs: record.destination.authority.thread.rootTimestamp,
                conversationId: record.destination.source.conversationId,
              },
              store,
              slack,
            });
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
      const eventSource = {
        kind: "slack" as const,
        eventId,
        thread: source.thread,
      };
      const event = Schema.decodeUnknownSync(BotEventSchema)({
        version: 1,
        id: await botEventId(source.address, eventSource),
        coordinator: source.address,
        ownerPrincipalId: source.ownerPrincipalId,
        source: eventSource,
        replyTo: { kind: "slack", thread: source.thread },
        content: { text: "status", reference: null },
        dependencies: { sourceIds: [], toolIds: [] },
      });
      const destination = Schema.decodeUnknownSync(SlackReplyDestinationSchema)(
        {
          source: source.address,
          ownerPrincipalId: source.ownerPrincipalId,
          authority: {
            appId: "app-A",
            eventId,
            userId: "slack-A",
            thread: source.thread,
          },
        }
      );
      await fixture.pi().commit(async (tx) => {
        const entry = await appendPassiveAnswer(
          tx,
          source.native.id,
          "The team has no active work.",
          source.faux.getModel()
        );
        await replies.enqueueIn(tx, {
          event,
          nativeId: source.native.id,
          answer: {
            kind: "local",
            entryId: entry.id,
            text: "The team has no active work.",
          },
          destination,
          dependencies: { sourceIds: [], toolIds: [] },
          blocked: false,
        });
        if (savedRetryAt !== undefined) {
          const saved = await tx.doc(CoordinatorReplies, event.id, null);
          assert.ok(saved.record);
          saved.record.delivery = {
            state: "retry",
            text: saved.record.text,
            retryAt: savedRetryAt,
          };
        }
      }, context);
      fixture.pi().resume();
      return event;
    },
    read: async (eventId: string) => {
      const saved = await fixture
        .pi()
        .snapshot(CoordinatorReplies, eventId, context);
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
