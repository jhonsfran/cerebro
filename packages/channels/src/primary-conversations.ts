import type { Database } from "@cerebro/db";
import {
  channelConversation,
  channelConversationOperation,
} from "@cerebro/db/schema/agents";
import { and, eq, like, sql } from "drizzle-orm";

import { digest } from "./security";
import { ChannelError } from "./types";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Conversation = typeof channelConversation.$inferSelect;
export interface PrimaryConversationOwner {
  readonly agentId: string;
  readonly organizationId: string;
  readonly ownerPrincipalId: string;
}
interface OpenConversation extends PrimaryConversationOwner {
  readonly operationId: string;
}

const requireBinding = (
  row: Conversation | undefined,
  input: PrimaryConversationOwner
): Conversation => {
  if (
    !row ||
    row.organizationId !== input.organizationId ||
    row.ownerPrincipalId !== input.ownerPrincipalId ||
    row.agentId !== input.agentId
  ) {
    throw new ChannelError(
      409,
      "conflict",
      "The conversation operation names another agent."
    );
  }
  return row;
};

export const isPrimaryConversation = async (
  conversation: Pick<
    Conversation,
    | "agentId"
    | "organizationId"
    | "ownerPrincipalId"
    | "bindingKey"
    | "conversationId"
  >
): Promise<boolean> => {
  const owner = {
    agentId: conversation.agentId,
    organizationId: conversation.organizationId,
    ownerPrincipalId: conversation.ownerPrincipalId,
  };
  const bindingKey = `primary:${await digest(owner)}`;
  return (
    conversation.bindingKey === bindingKey &&
    conversation.conversationId === `conversation:${await digest(bindingKey)}`
  );
};

export const listPrimaryConversationIds = async (
  database: Database,
  organizationId: string,
  ownerPrincipalId: string
): Promise<ReadonlyMap<string, string>> => {
  const rows = await database
    .select()
    .from(channelConversation)
    .where(
      and(
        eq(channelConversation.organizationId, organizationId),
        eq(channelConversation.ownerPrincipalId, ownerPrincipalId),
        like(channelConversation.bindingKey, "primary:%")
      )
    );
  const pairs = await Promise.all(
    rows.map(async (row) => ({
      row,
      primary: await isPrimaryConversation(row),
    }))
  );
  return new Map(
    pairs
      .filter(({ primary }) => primary)
      .map(({ row }) => [row.agentId, row.conversationId])
  );
};

export const resolvePrimaryConversationIn = async (
  tx: Transaction,
  input: PrimaryConversationOwner
): Promise<Conversation> => {
  const owner = {
    agentId: input.agentId,
    organizationId: input.organizationId,
    ownerPrincipalId: input.ownerPrincipalId,
  };
  const bindingKey = `primary:${await digest(owner)}`;
  const conversationId = `conversation:${await digest(bindingKey)}`;
  await tx
    .insert(channelConversation)
    .values({
      ...owner,
      bindingKey,
      conversationId,
      sessionId: `session:${await digest({ agentId: owner.agentId, conversationId, organizationId: owner.organizationId })}`,
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(channelConversation)
    .where(eq(channelConversation.bindingKey, bindingKey));
  return requireBinding(row, input);
};

export const openPrimaryConversation = async (
  database: Database,
  input: OpenConversation
): Promise<Conversation> => {
  const receiptKey = {
    operationId: input.operationId,
    organizationId: input.organizationId,
    ownerPrincipalId: input.ownerPrincipalId,
  };
  const operationKey = `conversation-open:${await digest(receiptKey)}`;
  const requestDigest = await digest({ agentId: input.agentId });
  return await database.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operationKey}))`
    );
    const [receipt] = await tx
      .select()
      .from(channelConversationOperation)
      .where(
        and(
          eq(channelConversationOperation.organizationId, input.organizationId),
          eq(
            channelConversationOperation.ownerPrincipalId,
            input.ownerPrincipalId
          ),
          eq(channelConversationOperation.operationId, input.operationId)
        )
      );
    if (receipt) {
      if (
        receipt.digest !== requestDigest ||
        receipt.agentId !== input.agentId
      ) {
        throw new ChannelError(
          409,
          "conflict",
          "The conversation operation names another agent."
        );
      }
      const [row] = await tx
        .select()
        .from(channelConversation)
        .where(eq(channelConversation.conversationId, receipt.conversationId));
      const conversation = requireBinding(row, input);
      if (conversation.sessionId !== receipt.sessionId) {
        throw new ChannelError(
          409,
          "conflict",
          "The conversation operation changed its session."
        );
      }
      return conversation;
    }
    const conversation = await resolvePrimaryConversationIn(tx, input);
    await tx.insert(channelConversationOperation).values({
      ...receiptKey,
      agentId: conversation.agentId,
      conversationId: conversation.conversationId,
      digest: requestDigest,
      sessionId: conversation.sessionId,
    });
    return conversation;
  });
};
