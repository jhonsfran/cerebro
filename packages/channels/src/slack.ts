import type { Database } from "@cerebro/db";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import { channelLinkEvent } from "@cerebro/db/schema/agents";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { contextByPrincipal, digest } from "./security";
import { createChannelService } from "./service";
import { createSlackApi } from "./slack-api";
import {
  readSlackEventTarget,
  resolveSlackEventDecision,
} from "./slack-event-receipts";
import { parseSlackCallback, parseSlackQueueDelivery } from "./slack-events";
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
const SIGNATURE = /^v0=(?<signature>[a-f0-9]{64})$/u;

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

export const receiveSlackEvent = async (
  database: Database,
  options: ChannelOptions,
  payload: unknown,
  configuration: SlackConfiguration,
  retry = false
) => {
  const callback = parseSlackCallback(payload, configuration);
  const { event } = callback;
  const { created, decision, eventKey, input } =
    await resolveSlackEventDecision(database, options, configuration, callback);
  const slack = createSlackApi(configuration, options.fetch);
  if (input.kind === "link") {
    const outcome = await consumeLinkCode(database, options, configuration, {
      code: input.code,
      eventKey,
      slackUserId: input.message.user,
    });
    if (!retry && !outcome.replayed) {
      await slack.send({
        channel: input.message.channel,
        text: outcome.linked ? LINKED : LINK_INVALID,
        threadTs: input.message.threadTs ?? input.message.ts,
      });
    }
    return outcome;
  }
  if (decision.kind === "ignored") {
    if (created && !retry) {
      if (decision.reason === "mention" && event.channel && event.user) {
        await slack.sendEphemeral({
          channel: event.channel,
          text: DIRECT_MESSAGES_ONLY,
          user: event.user,
        });
      }
      if (decision.reason === "unlinked" && input.kind === "message") {
        await slack.send({
          channel: input.message.channel,
          text: LINK_HINT,
          threadTs: input.message.threadTs ?? input.message.ts,
        });
      }
    }
    return decision.reason === "unlinked"
      ? { linked: false }
      : { ignored: true };
  }
  if (input.kind !== "message") {
    throw new ChannelError(
      503,
      "unavailable",
      "The saved Slack event decision does not match its input."
    );
  }
  const conversation = await readSlackEventTarget(
    database,
    options,
    configuration,
    decision,
    input.message
  );
  const context = await contextByPrincipal(
    database,
    options.organizationId,
    decision.ownerPrincipalId
  );
  const receipt = await createChannelService(database, options).admit(
    conversation,
    context,
    eventKey,
    input.message.text
  );
  return {
    accepted: true,
    conversationId: conversation.conversationId,
    receipt,
  };
};

export const receiveQueuedSlackEvent = async (
  database: Database,
  options: ChannelOptions,
  payload: unknown,
  redelivery = false
) => {
  const delivery = parseSlackQueueDelivery(payload);
  const { slack } = options;
  if (
    !slack ||
    delivery.organizationId !== options.organizationId ||
    delivery.appId !== slack.appId ||
    delivery.workspaceId !== slack.workspaceId ||
    delivery.agentId !== slack.agentId
  ) {
    throw new ChannelError(
      403,
      "forbidden",
      "The saved Slack delivery no longer matches its configuration."
    );
  }
  return await receiveSlackEvent(
    database,
    options,
    {
      api_app_id: delivery.appId,
      event: delivery.event,
      event_id: delivery.eventId,
      team_id: delivery.workspaceId,
      type: "event_callback",
    },
    slack,
    delivery.sourceRetry || redelivery
  );
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
});

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
    action.action_id === APPROVE_ACTION ? "allow" : "deny"
  );
};
