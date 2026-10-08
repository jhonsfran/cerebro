import type { Database } from "@cerebro/db";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import {
  channelConversation,
  channelLinkEvent,
} from "@cerebro/db/schema/agents";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { contextByPrincipal, digest } from "./security";
import { createChannelService } from "./service";
import { ChannelError } from "./types";
import type { ChannelOptions, SlackConfiguration } from "./types";

const TIMESTAMP_WINDOW_SECONDS = 300;
const LINK_COMMAND = /^(?:link|\/link)\s+(?<code>[a-f0-9]{64})$/iu;
const SIGNATURE = /^v0=(?<signature>[a-f0-9]{64})$/u;
const callbackSchema = z.object({
  api_app_id: z.string().min(1),
  event: z.object({
    bot_id: z.string().optional(),
    channel: z.string().optional(),
    channel_type: z.string().optional(),
    subtype: z.string().optional(),
    text: z.string().max(16_000).optional(),
    thread_ts: z.string().optional(),
    ts: z.string().optional(),
    type: z.string(),
    user: z.string().optional(),
  }),
  event_id: z.string().min(1),
  team_id: z.string().min(1),
  type: z.literal("event_callback"),
});

export const verifySlackRequest = async (
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  secret: string,
  now = Date.now()
): Promise<void> => {
  if (
    !timestamp ||
    !/^\d+$/u.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > TIMESTAMP_WINDOW_SECONDS
  ) {
    throw new ChannelError(
      401,
      "invalid-signature",
      "The Slack request timestamp is invalid."
    );
  }
  const matched = signature?.match(SIGNATURE);
  const encoded = matched?.groups?.signature;
  if (!encoded) {
    throw new ChannelError(
      401,
      "invalid-signature",
      "The Slack signature is invalid."
    );
  }
  const bytes = new Uint8Array(
    encoded.match(/../gu)?.map((byte) => Number.parseInt(byte, 16)) ?? []
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["verify"]
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      bytes,
      new TextEncoder().encode(`v0:${timestamp}:${rawBody}`)
    ))
  ) {
    throw new ChannelError(
      401,
      "invalid-signature",
      "The Slack signature is invalid."
    );
  }
};

export const receiveSlackEvent = async (
  database: Database,
  options: ChannelOptions,
  payload: unknown,
  configuration: SlackConfiguration
) => {
  const parsed = callbackSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ChannelError(422, "invalid-input", "The Slack event is invalid.");
  }
  const callback = parsed.data;
  if (
    callback.team_id !== configuration.workspaceId ||
    callback.api_app_id !== configuration.appId
  ) {
    throw new ChannelError(
      403,
      "forbidden",
      "The Slack workspace or app is not configured."
    );
  }
  const { event } = callback;
  if (event.type !== "message" || event.bot_id || event.subtype) {
    return { ignored: true };
  }
  if (
    event.channel_type !== "im" ||
    !event.user ||
    !event.channel ||
    !event.ts ||
    !event.text ||
    !event.channel.startsWith("D")
  ) {
    throw new ChannelError(
      403,
      "forbidden",
      "Only linked Slack direct messages are enabled."
    );
  }
  const slackUserId = event.user;
  const eventKey = `slack:${options.organizationId}:${configuration.appId}:${configuration.workspaceId}:${callback.event_id}`;
  const repository = createIdentityRepository(database);
  const linkCommand = event.text.match(LINK_COMMAND);
  if (linkCommand?.groups?.code) {
    const codeDigest = await digest(linkCommand.groups.code);
    const requestDigest = await digest({
      codeDigest,
      slackUserId: event.user,
      workspaceId: configuration.workspaceId,
    });
    return database.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${eventKey}))`
      );
      const transactionalIdentity = createIdentityRepository(tx);
      const [prior] = await tx
        .select()
        .from(channelLinkEvent)
        .where(eq(channelLinkEvent.eventKey, eventKey));
      if (prior) {
        if (prior.digest !== requestDigest) {
          throw new ChannelError(
            409,
            "digest-mismatch",
            "The Slack link event changed."
          );
        }
        const currentLink = await transactionalIdentity.resolveSlackLink(
          configuration.workspaceId,
          slackUserId
        );
        if (!currentLink || currentLink.principalId !== prior.principalId) {
          throw new ChannelError(
            403,
            "forbidden",
            "The Slack link is no longer active."
          );
        }
        return { linked: true, replayed: true };
      }
      const linked = await transactionalIdentity.consumeSlackLinkChallenge(
        options.organizationId,
        codeDigest,
        configuration.workspaceId,
        slackUserId,
        new Date(options.now?.() ?? Date.now())
      );
      if (!linked) {
        throw new ChannelError(
          403,
          "forbidden",
          "The link code is invalid, expired, or consumed."
        );
      }
      await tx.insert(channelLinkEvent).values({
        digest: requestDigest,
        eventKey,
        principalId: linked.principalId,
      });
      return { linked: true, replayed: false };
    });
  }
  const link = await repository.resolveSlackLink(
    configuration.workspaceId,
    event.user
  );
  if (!link || link.organizationId !== options.organizationId) {
    throw new ChannelError(
      403,
      "forbidden",
      "Link this Slack account before sending a message."
    );
  }
  const context = await contextByPrincipal(
    database,
    options.organizationId,
    link.principalId
  );
  const rootTimestamp = event.thread_ts ?? event.ts;
  const bindingKey = `pi-v1:slack:${await digest({ agentId: configuration.agentId, channelId: event.channel, organizationId: options.organizationId, principalId: link.principalId, rootTimestamp, userId: event.user, workspaceId: configuration.workspaceId })}`;
  const conversationId = `conversation:${await digest(bindingKey)}`;
  await database
    .insert(channelConversation)
    .values({
      agentId: configuration.agentId,
      bindingKey,
      channelId: event.channel,
      conversationId,
      engine: "pi-v1",
      kind: "slack",
      organizationId: options.organizationId,
      ownerPrincipalId: link.principalId,
      rootTimestamp,
      sessionId: `session:${await digest({ agentId: configuration.agentId, conversationId, organizationId: options.organizationId })}`,
      slackUserId: event.user,
      workspaceId: configuration.workspaceId,
    })
    .onConflictDoNothing();
  const [conversation] = await database
    .select()
    .from(channelConversation)
    .where(eq(channelConversation.conversationId, conversationId));
  if (!conversation) {
    throw new Error("The Slack conversation insert returned no binding.");
  }
  const receipt = await createChannelService(database, options).admit(
    conversation,
    context,
    eventKey,
    event.text
  );
  return { accepted: true, conversationId, receipt };
};
