import type {
  ChatApproval,
  ChatSnapshot,
} from "@cerebro/contracts/session-service";
import type { SlackDeliveryStore } from "@cerebro/contracts/slack-events";
import { toSlackText } from "@cerebro/contracts/slack-text";
/* oxlint-disable no-await-in-loop -- Slack messages are posted in thread order, and each result is recorded before the next call. */
import { canonicalToolArguments } from "@cerebro/contracts/tools";

import type { SlackApi, SlackBlock } from "./slack-api";

export const APPROVE_ACTION = "cerebro_approve";
export const DENY_ACTION = "cerebro_deny";

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
  readonly blocks?: readonly SlackBlock[];
}

const ARGUMENT_PREVIEW_LIMIT = 1500;
const approvalMessage = (
  approval: ChatApproval,
  thread: SlackThread
): DesiredMessage => {
  const key = `approval:${approval.approvalId}`;
  const name = approval.toolId;
  if (approval.state !== "pending") {
    const outcome = approval.state === "allowed" ? "Approved" : "Not approved";
    return { key, text: `${outcome}: \`${name}\`` };
  }
  const preview = canonicalToolArguments(approval.arguments).slice(
    0,
    ARGUMENT_PREVIEW_LIMIT
  );
  const value = JSON.stringify({
    approvalId: approval.approvalId,
    conversationId: thread.conversationId,
  });
  const text = `Approve \`${name}\`?`;
  return {
    blocks: [
      {
        text: {
          text: preview ? `${text}\n\`\`\`${preview}\`\`\`` : text,
          type: "mrkdwn",
        },
        type: "section",
      },
      {
        elements: [
          {
            action_id: APPROVE_ACTION,
            style: "primary",
            text: { text: "Approve", type: "plain_text" },
            type: "button",
            value,
          },
          {
            action_id: DENY_ACTION,
            style: "danger",
            text: { text: "Deny", type: "plain_text" },
            type: "button",
            value,
          },
        ],
        type: "actions",
      },
    ],
    key,
    text,
  };
};

const presentationFallbacks = (snapshot: ChatSnapshot) =>
  snapshot.tools.flatMap((tool) => {
    if (
      tool.toolName !== "render_ui" ||
      tool.state !== "succeeded" ||
      !tool.output.trim() ||
      !tool.resultMessageId
    ) {
      return [];
    }
    const resultIndex = snapshot.messages.findIndex(
      (message) => message.id === tool.resultMessageId
    );
    if (resultIndex === -1) {
      return [];
    }
    const afterResult = snapshot.messages.slice(resultIndex + 1);
    const nextTurn = afterResult.findIndex(
      (message) => message.role === "user"
    );
    if (nextTurn === -1 && snapshot.busy) {
      return [];
    }
    const turnEnd = nextTurn === -1 ? afterResult.length : nextTurn;
    const answered = afterResult
      .slice(0, turnEnd)
      .some((message) => message.outcome === "answered" && message.text.trim());
    return answered
      ? []
      : [
          {
            key: `presentation:${tool.id}`,
            messageId: tool.resultMessageId,
            text: tool.output.trim().slice(0, 8000),
          },
        ];
  });

export const desiredSlackMessages = async (
  snapshot: ChatSnapshot,
  thread: SlackThread,
  canShare: () => Promise<boolean>
): Promise<readonly DesiredMessage[]> => {
  const messages: DesiredMessage[] = [];
  const allowed = await canShare();
  const fallbacks = new Map<string, DesiredMessage[]>();
  for (const fallback of presentationFallbacks(snapshot)) {
    const values = fallbacks.get(fallback.messageId) ?? [];
    values.push(fallback);
    fallbacks.set(fallback.messageId, values);
  }
  for (const message of snapshot.messages) {
    if (
      message.role === "assistant" &&
      message.state === "complete" &&
      message.outcome !== "failed" &&
      message.outcome !== "interrupted" &&
      message.text.trim()
    ) {
      messages.push({
        key: `message:${message.id}`,
        text: allowed
          ? toSlackText(message.text.trim())
          : "I can no longer share this answer because your access changed.",
      });
    }
    for (const fallback of fallbacks.get(message.id) ?? []) {
      messages.push({
        key: fallback.key,
        text: allowed
          ? toSlackText(fallback.text)
          : "I can no longer share this answer because your access changed.",
      });
    }
  }
  for (const approval of snapshot.approvals) {
    messages.push(
      allowed
        ? approvalMessage(approval, thread)
        : {
            key: `approval:${approval.approvalId}`,
            text: "Your access changed. This approval is no longer available.",
          }
    );
  }
  return messages;
};

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
  const content = {
    channel: thread.channelId,
    text: message.text,
    ...(message.blocks ? { blocks: message.blocks } : {}),
  };
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

export const deliverSlackReplies = async (input: {
  readonly snapshot: ChatSnapshot;
  readonly thread: SlackThread;
  readonly store: SlackDeliveryStore;
  readonly slack: SlackApi;
  readonly canShare: () => Promise<boolean>;
}): Promise<void> => {
  let retry = false;
  for (const message of await desiredSlackMessages(
    input.snapshot,
    input.thread,
    input.canShare
  )) {
    retry = (await deliverSlackMessage({ ...input, message })) || retry;
  }
  if (retry) {
    throw new Error("Slack delivery is incomplete and will retry.");
  }
};
