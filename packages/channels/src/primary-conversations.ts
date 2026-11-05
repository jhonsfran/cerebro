import type { Database } from "@cerebro/db";
import {
  channelConversation,
  channelConversationOperation,
} from "@cerebro/db/schema/agents";
import { and, eq, sql } from "drizzle-orm";

import { digest } from "./security";
import { ChannelError } from "./types";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Conversation = typeof channelConversation.$inferSelect;
interface OpenConversation {
  readonly agentId: string;
  readonly operationId: string;
  readonly organizationId: string;
  readonly ownerPrincipalId: string;
}

const requireBinding = (
  row: Conversation | undefined,
  input: OpenConversation
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
  if (row.engine !== "pi-identity-v1" || row.retiredAt) {
    throw new ChannelError(409, "retired", "This conversation is retired.");
  }
  return row;
};

const primaryConversation = async (
  tx: Transaction,
  input: OpenConversation
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
      engine: "pi-identity-v1",
      kind: "web",
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
    const legacyKey = `pi-identity-v1:web:${await digest({ operationId: input.operationId, organizationId: input.organizationId, principalId: input.ownerPrincipalId })}`;
    const [legacy] = await tx
      .select()
      .from(channelConversation)
      .where(eq(channelConversation.bindingKey, legacyKey));
    const conversation = legacy
      ? requireBinding(legacy, input)
      : await primaryConversation(tx, input);
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
