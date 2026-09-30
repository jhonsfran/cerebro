/* oxlint-disable no-await-in-loop -- Serial claims persist each delivery attempt before the next provider effect. */
import { id } from "@cerebro/contracts";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import {
  channelConversation,
  channelInbox,
  channelItem,
  channelReply,
} from "@cerebro/db/schema/agents";
import { and, asc, eq, lt } from "drizzle-orm";
import { z } from "zod";

import { sessionServiceFor } from "./fixture-session";
import { projectSession } from "./projection";
import {
  authorize,
  authorizeContent,
  contextByPrincipal,
  unwrap,
} from "./security";
import { ChannelError, DELIVERY_TIMEOUT_MS, EFFECT_DEADLINE_MS } from "./types";
import type { ChannelOptions, SlackConfiguration } from "./types";

const slackResponse = z.object({
  channel: z.string().optional(),
  error: z.string().optional(),
  ok: z.boolean(),
  ts: z.string().optional(),
});
const sendReply = async (
  options: ChannelOptions,
  configuration: SlackConfiguration,
  destination: { channelId: string; rootTimestamp: string },
  text: string
): Promise<{
  state: "sent" | "unknown-outcome" | "failed";
  receipt: Record<string, unknown>;
}> => {
  let state: "sent" | "unknown-outcome" | "failed" = "unknown-outcome";
  let receipt: Record<string, unknown> = {
    reason: "The Slack response did not establish delivery.",
  };
  try {
    const response = await (options.fetch ?? fetch)(
      configuration.apiUrl ?? "https://slack.com/api/chat.postMessage",
      {
        body: JSON.stringify({
          channel: destination.channelId,
          text,
          thread_ts: destination.rootTimestamp,
        }),
        headers: {
          Authorization: `Bearer ${configuration.botToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      }
    );
    const parsed = slackResponse.safeParse(await response.json());
    if (
      response.ok &&
      parsed.success &&
      parsed.data.ok &&
      parsed.data.channel === destination.channelId &&
      parsed.data.ts
    ) {
      state = "sent";
      receipt = { channel: parsed.data.channel, timestamp: parsed.data.ts };
    } else if (
      parsed.success &&
      !parsed.data.ok &&
      parsed.data.error &&
      parsed.data.error !== "fatal_error" &&
      response.status < 500
    ) {
      state = "failed";
      receipt = { error: parsed.data.error, httpStatus: response.status };
    } else {
      receipt = {
        httpStatus: response.status,
        reason: "The provider response was ambiguous.",
      };
    }
  } catch {
    receipt = { reason: "The Slack request failed after delivery started." };
  }
  return { receipt, state };
};
export const drainChannelWork = async (
  options: ChannelOptions
): Promise<{ submitted: number; sent: number; unknown: number }> => {
  const now = options.now ?? Date.now;
  const recovered = await options.withDatabase((database) =>
    database
      .update(channelReply)
      .set({
        providerReceipt: {
          reason: "The delivery attempt ended without a durable receipt.",
        },
        state: "unknown-outcome",
      })
      .where(
        and(
          eq(channelReply.organizationId, options.organizationId),
          eq(channelReply.state, "sending"),
          lt(channelReply.startedAt, new Date(now() - DELIVERY_TIMEOUT_MS))
        )
      )
      .returning({ replyId: channelReply.replyId })
  );
  let submitted = 0;
  let sent = 0;
  let unknown = recovered.length;
  await options.withDatabase(async (database) => {
    const pending = await database
      .select()
      .from(channelInbox)
      .where(
        and(
          eq(channelInbox.organizationId, options.organizationId),
          eq(channelInbox.state, "pending")
        )
      )
      .orderBy(asc(channelInbox.lastAttemptAt))
      .limit(25);
    for (const row of pending) {
      await database
        .update(channelInbox)
        .set({ lastAttemptAt: new Date(now()) })
        .where(eq(channelInbox.eventKey, row.eventKey));
      try {
        const context = await contextByPrincipal(
          database,
          options.organizationId,
          row.envelope.context.actor.id
        );
        await authorize(
          database,
          options,
          context,
          "execute",
          "agent",
          row.envelope.agentId
        );
        const receipt = unwrap(
          await sessionServiceFor(database, options).submit(
            { event: row.envelope, type: "submit" },
            {
              deadlineAt: now() + EFFECT_DEADLINE_MS,
              operationId: id.operation(`submit:${row.envelope.eventId}`),
              requestDigest: id.digest(row.digest),
            }
          )
        );
        await database
          .update(channelInbox)
          .set({ receipt, state: "accepted" })
          .where(eq(channelInbox.eventKey, row.eventKey));
        submitted += 1;
      } catch (error) {
        if (error instanceof ChannelError && error.status === 403) {
          await database
            .update(channelInbox)
            .set({ state: "denied" })
            .where(eq(channelInbox.eventKey, row.eventKey));
        }
      }
    }
    const conversations = await database
      .select()
      .from(channelConversation)
      .where(
        and(
          eq(channelConversation.organizationId, options.organizationId),
          eq(channelConversation.projectionState, "active")
        )
      )
      .orderBy(asc(channelConversation.lastProjectedAt))
      .limit(25);
    for (const conversation of conversations) {
      try {
        const context = await contextByPrincipal(
          database,
          options.organizationId,
          conversation.ownerPrincipalId
        );
        await authorize(
          database,
          options,
          context,
          "read",
          "agent",
          conversation.agentId
        );
        await projectSession(database, options, conversation, context);
      } catch (error) {
        if (error instanceof ChannelError && error.status === 403) {
          await database
            .update(channelConversation)
            .set({ lastProjectedAt: new Date(now()), projectionState: "idle" })
            .where(
              eq(
                channelConversation.conversationId,
                conversation.conversationId
              )
            );
        } else if (error instanceof ChannelError && error.status === 503) {
          await database
            .update(channelConversation)
            .set({ lastProjectedAt: new Date(now()) })
            .where(
              eq(
                channelConversation.conversationId,
                conversation.conversationId
              )
            );
        } else {
          throw error;
        }
      }
    }
  });
  if (!options.slack?.botToken) {
    return { sent, submitted, unknown };
  }
  const configuration = options.slack;
  const ready = await options.withDatabase((database) =>
    database
      .select()
      .from(channelReply)
      .where(
        and(
          eq(channelReply.organizationId, options.organizationId),
          eq(channelReply.state, "ready")
        )
      )
      .limit(25)
  );
  for (const row of ready) {
    const attemptId = crypto.randomUUID();
    const destination = await options.withDatabase(async (database) => {
      const [conversation] = await database
        .select()
        .from(channelConversation)
        .where(eq(channelConversation.conversationId, row.conversationId));
      if (
        !conversation ||
        conversation.kind !== "slack" ||
        conversation.workspaceId !== configuration.workspaceId ||
        !conversation.slackUserId
      ) {
        return;
      }
      try {
        const link = await createIdentityRepository(database).resolveSlackLink(
          configuration.workspaceId,
          conversation.slackUserId
        );
        if (
          !link ||
          link.principalId !== conversation.ownerPrincipalId ||
          link.organizationId !== options.organizationId
        ) {
          throw new ChannelError(
            403,
            "forbidden",
            "The Slack recipient is no longer linked."
          );
        }
        const context = await contextByPrincipal(
          database,
          options.organizationId,
          link.principalId
        );
        await authorize(
          database,
          options,
          context,
          "read",
          "agent",
          conversation.agentId
        );
        const content = await database
          .select()
          .from(channelItem)
          .where(
            and(
              eq(channelItem.organizationId, options.organizationId),
              eq(channelItem.conversationId, conversation.conversationId)
            )
          );
        const outputs = content.filter(
          (entry) =>
            entry.item.runId === row.runId && entry.item.type === "output"
        );
        if (options.mode === "production" && outputs.length === 0) {
          throw new ChannelError(
            403,
            "unauthorized",
            "Reply dependencies are not available."
          );
        }
        for (const entry of content) {
          if (entry.item.runId === row.runId) {
            await authorizeContent(database, options, context, entry.item);
          }
        }
      } catch (error) {
        if (error instanceof ChannelError && error.status === 403) {
          await database
            .update(channelReply)
            .set({
              providerReceipt: {
                reason: "Current authorization denied reply delivery.",
              },
              state: "failed",
            })
            .where(
              and(
                eq(channelReply.replyId, row.replyId),
                eq(channelReply.state, "ready")
              )
            );
          return;
        }
        throw error;
      }
      const claimed = await database
        .update(channelReply)
        .set({ attemptId, startedAt: new Date(now()), state: "sending" })
        .where(
          and(
            eq(channelReply.replyId, row.replyId),
            eq(channelReply.state, "ready")
          )
        )
        .returning();
      return claimed.length > 0 ? conversation : undefined;
    });
    if (!destination?.channelId || !destination.rootTimestamp) {
      continue;
    }
    const { state, receipt } = await sendReply(
      options,
      configuration,
      {
        channelId: destination.channelId,
        rootTimestamp: destination.rootTimestamp,
      },
      row.text
    );
    await options.withDatabase((database) =>
      database
        .update(channelReply)
        .set({ providerReceipt: receipt, state })
        .where(
          and(
            eq(channelReply.replyId, row.replyId),
            eq(channelReply.state, "sending"),
            eq(channelReply.attemptId, attemptId)
          )
        )
    );
    if (state === "sent") {
      sent += 1;
    }
    if (state === "unknown-outcome") {
      unknown += 1;
    }
  }
  return { sent, submitted, unknown };
};
