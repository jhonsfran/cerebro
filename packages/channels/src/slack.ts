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
import { createSlackApi } from "./slack-api";
import { APPROVE_ACTION, DENY_ACTION } from "./slack-replies";
import { ChannelError } from "./types";
import type { ChannelOptions, SlackConfiguration } from "./types";

const LINK_HINT =
  "Link your Slack account first: in Cerebro, choose *Link your Slack account* and send me the `link <code>` message it shows.";
const LINKED = "Your Slack account is linked. Send me a message to start.";
const LINK_INVALID =
  "That link code is invalid, expired, or already used. Create a new one in Cerebro.";
const DIRECT_MESSAGES_ONLY =
  "I answer in direct messages, so only you can see the answer. Open a DM with me to ask.";
export const START_FAILED =
  "Sorry, I could not start on that. Please send it again.";

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

// Consumes a one-time link code exactly once per Slack event.
const consumeLinkCode = async (
  database: Database,
  options: ChannelOptions,
  configuration: SlackConfiguration,
  input: {
    readonly code: string;
    readonly eventKey: string;
    readonly slackUserId: string;
  }
): Promise<{ linked: boolean; replayed: boolean }> => {
  const codeDigest = await digest(input.code);
  const requestDigest = await digest({
    codeDigest,
    slackUserId: input.slackUserId,
    workspaceId: configuration.workspaceId,
  });
  return await database.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${input.eventKey}))`
    );
    const transactionalIdentity = createIdentityRepository(tx);
    const [prior] = await tx
      .select()
      .from(channelLinkEvent)
      .where(eq(channelLinkEvent.eventKey, input.eventKey));
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
        input.slackUserId
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
      input.slackUserId,
      new Date(options.now?.() ?? Date.now())
    );
    if (!linked) {
      return { linked: false, replayed: false };
    }
    await tx.insert(channelLinkEvent).values({
      digest: requestDigest,
      eventKey: input.eventKey,
      principalId: linked.principalId,
    });
    return { linked: true, replayed: false };
  });
};

type SlackEvent = z.infer<typeof callbackSchema>["event"];
interface DirectMessage {
  readonly channel: string;
  readonly text: string;
  readonly ts: string;
  readonly threadTs?: string;
  readonly user: string;
}

// Only a person's message in a direct-message channel starts work.
const directMessage = (event: SlackEvent): DirectMessage | undefined => {
  const { channel, text, ts, user } = event;
  if (
    event.type !== "message" ||
    event.channel_type !== "im" ||
    !user ||
    !channel?.startsWith("D") ||
    !ts ||
    !text
  ) {
    return;
  }
  return { channel, text, threadTs: event.thread_ts, ts, user };
};

// One thread is one conversation; its first message names the thread.
const bindConversation = async (
  database: Database,
  options: ChannelOptions,
  configuration: SlackConfiguration,
  message: DirectMessage,
  principalId: string
) => {
  const rootTimestamp = message.threadTs ?? message.ts;
  const bindingKey = `pi-v1:slack:${await digest({ agentId: configuration.agentId, channelId: message.channel, organizationId: options.organizationId, principalId, rootTimestamp, userId: message.user, workspaceId: configuration.workspaceId })}`;
  const conversationId = `conversation:${await digest(bindingKey)}`;
  await database
    .insert(channelConversation)
    .values({
      agentId: configuration.agentId,
      bindingKey,
      channelId: message.channel,
      conversationId,
      engine: "pi-v1",
      kind: "slack",
      organizationId: options.organizationId,
      ownerPrincipalId: principalId,
      rootTimestamp,
      sessionId: `session:${await digest({ agentId: configuration.agentId, conversationId, organizationId: options.organizationId })}`,
      slackUserId: message.user,
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
  return conversation;
};

export const receiveSlackEvent = async (
  database: Database,
  options: ChannelOptions,
  payload: unknown,
  configuration: SlackConfiguration,
  retry = false
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
  const slack = createSlackApi(configuration, options.fetch);
  if (event.bot_id || event.subtype) {
    return { ignored: true };
  }
  if (event.type === "app_mention") {
    // Answers can carry company content, so they never go to a shared channel.
    if (!retry && event.channel && event.user) {
      await slack.sendEphemeral({
        channel: event.channel,
        text: DIRECT_MESSAGES_ONLY,
        user: event.user,
      });
    }
    return { ignored: true };
  }
  const message = directMessage(event);
  if (!message) {
    return { ignored: true };
  }
  // A retried event already got its hint; only idempotent work runs again.
  const reply = async (text: string) => {
    if (!retry) {
      await slack.send({
        channel: message.channel,
        text,
        threadTs: message.threadTs ?? message.ts,
      });
    }
  };
  const eventKey = `slack:${options.organizationId}:${configuration.appId}:${configuration.workspaceId}:${callback.event_id}`;
  const linkCommand = message.text.match(LINK_COMMAND);
  if (linkCommand?.groups?.code) {
    const outcome = await consumeLinkCode(database, options, configuration, {
      code: linkCommand.groups.code,
      eventKey,
      slackUserId: message.user,
    });
    if (!outcome.replayed) {
      await reply(outcome.linked ? LINKED : LINK_INVALID);
    }
    return outcome;
  }
  const link = await createIdentityRepository(database).resolveSlackLink(
    configuration.workspaceId,
    message.user
  );
  if (!link || link.organizationId !== options.organizationId) {
    await reply(LINK_HINT);
    return { linked: false };
  }
  const context = await contextByPrincipal(
    database,
    options.organizationId,
    link.principalId
  );
  const conversation = await bindConversation(
    database,
    options,
    configuration,
    message,
    link.principalId
  );
  const receipt = await createChannelService(database, options).admit(
    conversation,
    context,
    eventKey,
    message.text
  );
  return {
    accepted: true,
    conversationId: conversation.conversationId,
    receipt,
  };
};

const interactionSchema = z.object({
  actions: z
    .array(
      z.object({
        action_id: z.string(),
        action_ts: z.string().min(1),
        value: z.string().max(2000),
      })
    )
    .min(1),
  api_app_id: z.string().min(1),
  team: z.object({ id: z.string().min(1) }),
  type: z.literal("block_actions"),
  user: z.object({ id: z.string().min(1) }),
});
const approvalValue = z.strictObject({
  approvalId: z.string().min(1).max(512),
  conversationId: z.string().min(1).max(512),
  runId: z.string().min(1).max(512),
});

// An Approve or Deny button press decides the approval as the linked person,
// with the same permission checks as the web app.
export const receiveSlackInteraction = async (
  database: Database,
  options: ChannelOptions,
  payload: unknown,
  configuration: SlackConfiguration
) => {
  const parsed = interactionSchema.safeParse(payload);
  if (!parsed.success) {
    return { ignored: true };
  }
  const interaction = parsed.data;
  if (
    interaction.team.id !== configuration.workspaceId ||
    interaction.api_app_id !== configuration.appId
  ) {
    throw new ChannelError(
      403,
      "forbidden",
      "The Slack workspace or app is not configured."
    );
  }
  const [action] = interaction.actions;
  if (
    !action ||
    (action.action_id !== APPROVE_ACTION && action.action_id !== DENY_ACTION)
  ) {
    return { ignored: true };
  }
  let value: z.infer<typeof approvalValue>;
  try {
    value = approvalValue.parse(JSON.parse(action.value));
  } catch {
    throw new ChannelError(
      422,
      "invalid-input",
      "The Slack action is invalid."
    );
  }
  const link = await createIdentityRepository(database).resolveSlackLink(
    configuration.workspaceId,
    interaction.user.id
  );
  if (!link || link.organizationId !== options.organizationId) {
    throw new ChannelError(
      403,
      "forbidden",
      "Link this Slack account before approving."
    );
  }
  const context = await contextByPrincipal(
    database,
    options.organizationId,
    link.principalId
  );
  return await createChannelService(database, options).approveAs(
    context,
    value.conversationId,
    value.approvalId,
    `slack:${configuration.workspaceId}:${action.action_ts}`,
    value.runId,
    action.action_id === APPROVE_ACTION ? "allow" : "deny"
  );
};
