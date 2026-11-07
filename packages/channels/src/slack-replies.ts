import type { SlackDeliveryStore } from "@cerebro/contracts/slack-events";

import type { SlackApi } from "./slack-api";

// What was last posted for one Slack message. An "unknown" post may have been
// delivered, so it is never posted again; it can still be edited once its ts
// is known.
export type {
  SlackDelivery,
  SlackDeliveryStore,
} from "@cerebro/contracts/slack-events";
export interface SlackThread {
  readonly channelId: string;
  readonly threadTs: string;
  readonly conversationId: string;
}
interface DesiredMessage {
  readonly key: string;
  readonly text: string;
}

export const deliverSlackMessage = async (input: {
  readonly message: DesiredMessage;
  readonly thread: SlackThread;
  readonly store: SlackDeliveryStore;
  readonly slack: SlackApi;
  readonly beforePost?: () => Promise<boolean>;
}): Promise<boolean> => {
  const { message, store, slack, thread } = input;
  const prior = await store.get(message.key);
  if (prior?.text === message.text && prior.state !== "retry") {
    return false;
  }
  const content = { channel: thread.channelId, text: message.text };
  if (prior?.state === "sent") {
    const updated = await slack.edit({ ...content, ts: prior.ts });
    if (updated.state === "sent" || updated.state === "failed") {
      await store.set(message.key, { ...prior, text: message.text });
    } else {
      return true;
    }
    return false;
  }
  if (prior && prior.state !== "retry") {
    // A post that may have been delivered is never repeated.
    return false;
  }
  const canPost = async (): Promise<boolean> => {
    try {
      if (input.beforePost && !(await input.beforePost())) {
        await store.set(message.key, {
          state: "blocked",
          text: message.text,
          reason: "access-changed",
        });
        return false;
      }
      return true;
    } catch (error) {
      await store.set(message.key, { state: "retry", text: message.text });
      throw error;
    }
  };
  if (!(await canPost())) {
    return false;
  }
  await store.set(message.key, { state: "unknown", text: message.text });
  if (!(await canPost())) {
    return false;
  }
  const posted = await slack.send({
    ...content,
    threadTs: thread.threadTs,
  });
  if (posted.state === "retry") {
    await store.set(message.key, {
      state: "retry",
      text: message.text,
      ...(posted.retryAt === undefined ? {} : { retryAt: posted.retryAt }),
    });
    return true;
  }
  await store.set(
    message.key,
    posted.state === "sent"
      ? { state: "sent", text: message.text, ts: posted.ts }
      : { state: posted.state, text: message.text }
  );
  return false;
};
