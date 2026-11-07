/* oxlint-disable no-await-in-loop -- Permission reads share one request-scoped PostgreSQL connection. */
import { id } from "@cerebro/contracts";
import type {
  Action,
  EventAddress,
  ExecutionContext,
} from "@cerebro/contracts";
import type { InspectionQuery } from "@cerebro/contracts/inspection";
import type {
  ChatReceipt,
  ChatControl,
} from "@cerebro/contracts/session-service";
import type { Database } from "@cerebro/db";
import { createAgentRepository } from "@cerebro/db/repositories/agents";
import { channelConversation } from "@cerebro/db/schema/agents";
import { and, asc, eq, isNull } from "drizzle-orm";

import { openPrimaryConversation } from "./primary-conversations";
import { authorize, principalContext, unwrap } from "./security";
import { ChannelError, EFFECT_DEADLINE_MS } from "./types";
import type { ChannelOptions } from "./types";

type Conversation = typeof channelConversation.$inferSelect;
const conversationAddress = (row: Conversation): EventAddress => ({
  agentId: id.agent(row.agentId),
  conversationId: id.conversation(row.conversationId),
  organizationId: id.organization(row.organizationId),
  sessionId: id.session(row.sessionId),
});
const same = (
  row: Conversation,
  options: ChannelOptions,
  context: ExecutionContext
): boolean =>
  row.organizationId === options.organizationId &&
  row.ownerPrincipalId === context.actor.id;

const requireActive = (row: Conversation): void => {
  if (row.engine !== "pi-identity-v1" || row.retiredAt) {
    throw new ChannelError(
      409,
      "retired",
      "This conversation is retired. Start a new conversation."
    );
  }
};
export const createConversationService = (
  database: Database,
  options: ChannelOptions
) => {
  const now = options.now ?? Date.now;
  const readOptions = () => ({ deadlineAt: now() + EFFECT_DEADLINE_MS });
  const current = (userId: string) =>
    principalContext(database, options.organizationId, userId);
  const requireConversation = async (
    conversationId: string,
    context: ExecutionContext,
    action: Action
  ) => {
    const [row] = await database
      .select()
      .from(channelConversation)
      .where(eq(channelConversation.conversationId, conversationId));
    if (!row || !same(row, options, context)) {
      throw new ChannelError(
        404,
        "not-found",
        "The conversation was not found."
      );
    }
    await authorize(database, options, context, action, "agent", row.agentId);
    return row;
  };

  const createConversation = async (
    userId: string,
    agentId: string,
    operationId: string
  ) => {
    const context = await current(userId);
    await authorize(database, options, context, "execute", "agent", agentId);
    unwrap(
      await createAgentRepository(database).get(
        id.organization(options.organizationId),
        id.agent(agentId),
        "latest",
        readOptions()
      )
    );
    const row = await openPrimaryConversation(database, {
      agentId,
      operationId,
      organizationId: options.organizationId,
      ownerPrincipalId: context.actor.id,
    });
    return {
      agentId: row.agentId,
      conversationId: row.conversationId,
      sessionId: row.sessionId,
    };
  };
  const controlConversation = async (
    userId: string,
    conversationId: string,
    command: ChatControl
  ) => {
    const context = await current(userId);
    const row = await requireConversation(conversationId, context, "execute");
    requireActive(row);
    return await options
      .sessions(database)
      .control({ address: conversationAddress(row), context, command });
  };
  const admit = async (
    conversation: Conversation,
    context: ExecutionContext,
    operationId: string,
    text: string
  ): Promise<ChatReceipt> => {
    requireActive(conversation);
    if (!same(conversation, options, context)) {
      throw new ChannelError(
        404,
        "not-found",
        "The conversation was not found."
      );
    }
    await authorize(
      database,
      options,
      context,
      "execute",
      "agent",
      conversation.agentId
    );
    return await options.sessions(database).send({
      address: conversationAddress(conversation),
      context,
      operationId,
      text,
    });
  };
  const submit = async (
    userId: string,
    conversationId: string,
    operationId: string,
    text: string
  ) => {
    const context = await current(userId);
    const row = await requireConversation(conversationId, context, "execute");
    return { receipt: await admit(row, context, operationId, text) };
  };
  const readConversation = async (userId: string, conversationId: string) => {
    const context = await current(userId);
    const row = await requireConversation(conversationId, context, "read");
    requireActive(row);
    const snapshot = await options.sessions(database).read({
      address: conversationAddress(row),
      context,
    });
    return {
      agentId: row.agentId,
      conversationId,
      mode: options.mode,
      sessionId: row.sessionId,
      snapshot,
    };
  };
  const conversationAccess = async (userId: string, conversationId: string) => {
    const context = await current(userId);
    const row = await requireConversation(conversationId, context, "read");
    requireActive(row);
    return { address: conversationAddress(row), context };
  };
  const chatAccess = async (userId: string, conversationId: string) => {
    const access = await conversationAccess(userId, conversationId);
    await options.sessions(database).read(access);
    return access;
  };
  const inspectConversation = async (
    userId: string,
    conversationId: string,
    query: InspectionQuery
  ) => {
    const access = await conversationAccess(userId, conversationId);
    if (!options.inspection) {
      throw new ChannelError(503, "unavailable", "Inspection is unavailable.");
    }
    return await options.inspection.read({ ...access, query });
  };
  const listConversations = async (userId: string) => {
    const context = await current(userId);
    const rows = await database
      .select()
      .from(channelConversation)
      .where(
        and(
          eq(channelConversation.organizationId, options.organizationId),
          eq(channelConversation.ownerPrincipalId, context.actor.id),
          eq(channelConversation.engine, "pi-identity-v1"),
          isNull(channelConversation.retiredAt)
        )
      )
      .orderBy(asc(channelConversation.createdAt));
    const conversations: Conversation[] = [];
    for (const row of rows) {
      try {
        await authorize(
          database,
          options,
          context,
          "read",
          "agent",
          row.agentId
        );
        conversations.push(row);
      } catch (error) {
        if (!(error instanceof ChannelError && error.status === 403)) {
          throw error;
        }
      }
    }
    return { conversations };
  };
  const approveAs = async (
    context: ExecutionContext,
    conversationId: string,
    approvalId: string,
    decision: "allow" | "deny"
  ) => {
    const row = await requireConversation(conversationId, context, "approve");
    requireActive(row);
    return {
      approval: await options.sessions(database).decide({
        address: conversationAddress(row),
        approvalId,
        context,
        decision,
      }),
    };
  };
  const approve = async (
    userId: string,
    conversationId: string,
    approvalId: string,
    decision: "allow" | "deny"
  ) => approveAs(await current(userId), conversationId, approvalId, decision);
  const stop = async (userId: string, conversationId: string) => {
    const context = await current(userId);
    const row = await requireConversation(conversationId, context, "execute");
    requireActive(row);
    return await options.sessions(database).stop({
      address: conversationAddress(row),
      context,
    });
  };
  const history = async (userId: string, conversationId: string) => {
    const { snapshot } = await readConversation(userId, conversationId);
    return { messages: snapshot.messages };
  };
  const source = async (
    userId: string,
    conversationId: string,
    sourceId: string
  ) => {
    const context = await current(userId);
    const conversation = await requireConversation(
      conversationId,
      context,
      "read"
    );
    if (options.readSource) {
      await authorize(database, options, context, "read", "memory", sourceId);
      return {
        ...unwrap(
          await options.readSource(database, context, {
            conversationId,
            sessionId: conversation.sessionId,
            sourceId,
          })
        ),
        mode: options.mode,
      };
    }
    throw new ChannelError(
      503,
      "provider-unavailable",
      "The source adapter is not configured."
    );
  };
  return {
    admit,
    approve,
    approveAs,
    chatAccess,
    conversationAccess,
    controlConversation,
    createConversation,
    history,
    inspectConversation,
    listConversations,
    readConversation,
    source,
    stop,
    submit,
  };
};
