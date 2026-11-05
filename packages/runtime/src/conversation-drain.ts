/* oxlint-disable no-await-in-loop -- Owned subtrees and scan cursors must be exhausted on one Pi transaction line. */
import { AgentDoc, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import type { ConversationId, Cursor, Tx } from "@earendil-works/pi-durable";

import { BotEventQueue, BotEventReceipts } from "./coordinator-event-state.ts";

export const oldestHeldEventIn = async (
  tx: Tx,
  root: ConversationId
): Promise<string | null> => {
  const queue = await tx.doc(BotEventQueue);
  let oldest: { id: string; sequence: number } | undefined;
  for (const [id, item] of Object.entries(queue.pending)) {
    if (item.nativeId !== root) {
      continue;
    }
    const saved = await tx.doc(BotEventReceipts, id, null);
    const { receipt } = saved;
    if (
      receipt?.delivery.kind !== "coordinator" ||
      receipt.delivery.admission.kind !== "held"
    ) {
      continue;
    }
    const task = await tx.task(receipt.delivery.taskId);
    if (!task || task.abortRequested || task.state.status === "terminal") {
      continue;
    }
    if (!oldest || receipt.sequence < oldest.sequence) {
      oldest = { id, sequence: receipt.sequence };
    }
  }
  return oldest?.id ?? null;
};

export const ownedConversationsIn = async (
  tx: Tx,
  root: ConversationId
): Promise<ConversationId[]> => {
  const conversations = new Set([root]);
  for (const conversationId of conversations) {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanConversations(
        { ownerConversationId: conversationId },
        64,
        cursor
      );
      for (const child of page.items) {
        conversations.add(child.id);
      }
      cursor = page.next;
    } while (cursor);
  }
  return [...conversations];
};

export const nativeDrainIn = async (
  tx: Tx,
  root: ConversationId
): Promise<boolean> => {
  const conversations = await ownedConversationsIn(tx, root);
  for (const conversationId of conversations) {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanTasks({ conversationId }, 64, cursor);
      if (
        page.items.some(
          (task) =>
            task.state.status !== "terminal" &&
            task.kind !== "cerebro.bot-event-delivery" &&
            task.kind !== "cerebro.coordinator-reply"
        )
      ) {
        return false;
      }
      cursor = page.next;
    } while (cursor);
    const live = await tx.doc(LiveDoc, conversationId);
    const inbox = await tx.doc(InboxDoc, conversationId);
    if (
      inbox.items.length ||
      live.run ||
      live.generation ||
      live.compactions?.length ||
      live.tools?.some((tool) => tool.status !== "done") ||
      live.nestedTools?.some((tool) => tool.status !== "done")
    ) {
      return false;
    }
  }
  const queue = await tx.doc(BotEventQueue);
  for (const [key, item] of Object.entries(queue.pending)) {
    if (item.nativeId !== root) {
      continue;
    }
    const document = await tx.doc(BotEventReceipts, key, null);
    const delivery = document.receipt?.delivery;
    if (
      delivery?.kind === "coordinator" &&
      (delivery.admission.kind === "claimed" ||
        delivery.admission.kind === "submitted")
    ) {
      return false;
    }
  }
  return true;
};

export const selectedRegistrationsIn = async (
  tx: Tx,
  root: ConversationId
): Promise<Set<string>> => {
  const names = new Set<string>();
  for (const id of await ownedConversationsIn(tx, root)) {
    const agent = await tx.doc(AgentDoc, id);
    if (agent.model) {
      names.add(agent.model.provider);
    }
    if (Array.isArray(agent.extensions)) {
      for (const name of agent.extensions) {
        names.add(name);
      }
    } else {
      for (const name of agent.extensions?.add ?? []) {
        names.add(name);
      }
    }
  }
  return names;
};
