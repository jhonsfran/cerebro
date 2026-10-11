import type {
  CanonicalOutput,
  DomainSnapshot,
} from "@cerebro/contracts/session-service";
/* oxlint-disable no-await-in-loop -- Slack messages are posted in thread order, and each result is recorded before the next call. */
import { canonicalToolArguments } from "@cerebro/contracts/tools";

import { toSlackText } from "./slack-api";
import type { SlackApi, SlackBlock } from "./slack-api";

export const APPROVE_ACTION = "cerebro_approve";
export const DENY_ACTION = "cerebro_deny";

// What was last posted for one Slack message. An "unknown" post may have been
// delivered, so it is never posted again; it can still be edited once its ts
// is known.
export interface SlackDelivery {
  readonly ts?: string;
  readonly text: string;
  readonly state: "sent" | "unknown" | "failed";
}
export interface SlackDeliveryStore {
  readonly get: (key: string) => SlackDelivery | undefined;
  readonly set: (key: string, delivery: SlackDelivery) => void;
}
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
const runText: Record<string, string> = {
  cancelled: "Cancelled.",
  failed: "Sorry, I could not finish this request. Please try again.",
  queued: "Working on it…",
  running: "Working on it…",
  "waiting-for-approval": "Waiting for your approval…",
};

const answerText = (output: CanonicalOutput): string => {
  const sources = output.citations.map((citation) => citation.sourceUri);
  const text = toSlackText(output.text.trim() || "Done.");
  return sources.length > 0
    ? `${text}\n\n_Sources: ${[...new Set(sources)].join(", ")}_`
    : text;
};

const approvalMessage = (
  snapshot: DomainSnapshot,
  approval: DomainSnapshot["approvals"][number],
  thread: SlackThread
): DesiredMessage => {
  const key = `approval:${approval.approvalId}`;
  const tool = snapshot.tools.find(
    (entry) => entry.operationId === approval.operationId
  );
  const name = tool?.toolId ?? "a tool";
  if (approval.state !== "pending") {
    const outcome = approval.state === "allowed" ? "Approved" : "Not approved";
    return { key, text: `${outcome}: \`${name}\`` };
  }
  const preview = tool
    ? canonicalToolArguments(tool.arguments).slice(0, ARGUMENT_PREVIEW_LIMIT)
    : "";
  const value = JSON.stringify({
    approvalId: approval.approvalId,
    conversationId: thread.conversationId,
    runId: approval.runId,
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

// One message per run shows its progress and becomes the answer; one message
// per approval carries the buttons and then the decision.
export const desiredSlackMessages = async (
  snapshot: DomainSnapshot,
  thread: SlackThread,
  canShare: (output: CanonicalOutput) => Promise<boolean>
): Promise<readonly DesiredMessage[]> => {
  const messages: DesiredMessage[] = [];
  for (const run of snapshot.runs) {
    let text = runText[run.state] ?? "Done.";
    if (run.state === "completed") {
      const output = snapshot.outputs.find(
        (entry) => entry.runId === run.runId
      );
      const joined = snapshot.outputs.some(
        (entry) => entry.runId !== run.runId && entry.runIds.includes(run.runId)
      );
      if (output) {
        text = (await canShare(output))
          ? answerText(output)
          : "I can no longer share this answer because your access changed.";
      } else if (joined) {
        text = "Answered together with your other message.";
      }
    }
    messages.push({ key: `run:${run.runId}`, text });
    for (const approval of snapshot.approvals) {
      if (approval.runId === run.runId) {
        messages.push(approvalMessage(snapshot, approval, thread));
      }
    }
  }
  return messages;
};

export const deliverSlackReplies = async (input: {
  readonly snapshot: DomainSnapshot;
  readonly thread: SlackThread;
  readonly store: SlackDeliveryStore;
  readonly slack: SlackApi;
  readonly canShare: (output: CanonicalOutput) => Promise<boolean>;
}): Promise<void> => {
  const { store, slack, thread } = input;
  let retry = false;
  // An answer already posted with this text needs no new access check.
  const canShare = async (output: CanonicalOutput) =>
    store.get(`run:${output.runId}`)?.text === answerText(output) ||
    (await input.canShare(output));
  for (const message of await desiredSlackMessages(
    input.snapshot,
    thread,
    canShare
  )) {
    const prior = store.get(message.key);
    if (prior?.text === message.text) {
      continue;
    }
    const content = {
      channel: thread.channelId,
      text: message.text,
      ...(message.blocks ? { blocks: message.blocks } : {}),
    };
    if (prior?.ts) {
      const updated = await slack.edit({ ...content, ts: prior.ts });
      if (updated.state === "sent" || updated.state === "failed") {
        // A rejected edit is not retried; the message keeps its last text.
        store.set(message.key, { ...prior, text: message.text });
      } else {
        retry = true;
      }
      continue;
    }
    if (prior) {
      // A post that may have been delivered is never repeated.
      continue;
    }
    const posted = await slack.send({
      ...content,
      threadTs: thread.threadTs,
    });
    if (posted.state === "retry") {
      retry = true;
      continue;
    }
    store.set(message.key, {
      state: posted.state,
      text: message.text,
      ...(posted.state === "sent" ? { ts: posted.ts } : {}),
    });
  }
  if (retry) {
    throw new Error("Slack delivery is incomplete and will retry.");
  }
};
