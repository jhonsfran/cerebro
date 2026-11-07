/* oxlint-disable no-await-in-loop -- Owned subtrees and scan cursors must be exhausted on one Pi transaction line. */
import { AgentDoc, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import type { ConversationId, Cursor, Tx } from "@earendil-works/pi-durable";

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
