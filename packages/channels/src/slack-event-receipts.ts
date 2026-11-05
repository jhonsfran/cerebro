import type { EventAddress } from "@cerebro/contracts/events";
import { id } from "@cerebro/contracts/identity";
import { SlackPrimaryDecisionSchema } from "@cerebro/contracts/slack-events";
import type { SlackPrimaryDecision } from "@cerebro/contracts/slack-events";
import { SlackThreadSchema } from "@cerebro/contracts/work";
import type { Database } from "@cerebro/db";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import {
  channelConversation,
  channelSlackEventReceipt,
} from "@cerebro/db/schema/agents";
import { eq, sql } from "drizzle-orm";
import { Schema } from "effect";
import { z } from "zod";

import { resolvePrimaryConversationIn } from "./primary-conversations";
import { contextByPrincipal, digest } from "./security";
import type { slackCallbackSchema } from "./slack-events";
import { ChannelError } from "./types";
import type { ChannelOptions, SlackConfiguration } from "./types";

const LINK_COMMAND = /^(?:link|\/link)\s+(?<code>[a-f0-9]{64})$/iu;
const identifier = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value);
const ignoredReason = z.enum([
  "bot",
  "subtype",
  "mention",
  "unsupported",
  "unlinked",
  "link-command",
]);
const legacyDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("admit"),
    ownerPrincipalId: identifier,
    sourceEventAddress: z.strictObject({
      agentId: identifier,
      conversationId: identifier,
      organizationId: identifier,
      sessionId: identifier,
    }),
  }),
  z.strictObject({ kind: z.literal("ignored"), reason: ignoredReason }),
]);
export type SlackEventDecision =
  | z.infer<typeof legacyDecisionSchema>
  | SlackPrimaryDecision;
type SlackCallback = z.infer<typeof slackCallbackSchema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
interface DirectMessage {
  readonly channel: string;
  readonly text: string;
  readonly ts: string;
  readonly threadTs?: string;
  readonly user: string;
}
type SlackInput =
  | {
      readonly kind: "ignored";
      readonly reason: "bot" | "subtype" | "mention" | "unsupported";
    }
  | { readonly kind: "message"; readonly message: DirectMessage }
  | {
      readonly kind: "link";
      readonly message: DirectMessage;
      readonly code: string;
    };

const classify = (event: SlackCallback["event"]): SlackInput => {
  if (event.bot_id) {
    return { kind: "ignored", reason: "bot" };
  }
  if (event.subtype) {
    return { kind: "ignored", reason: "subtype" };
  }
  if (event.type === "app_mention") {
    return { kind: "ignored", reason: "mention" };
  }
  const { channel, text, ts, user } = event;
  if (
    event.type !== "message" ||
    event.channel_type !== "im" ||
    !user ||
    !channel?.startsWith("D") ||
    !ts ||
    !text
  ) {
    return { kind: "ignored", reason: "unsupported" };
  }
  const message = { channel, text, threadTs: event.thread_ts, ts, user };
  const code = text.match(LINK_COMMAND)?.groups?.code;
  return code ? { code, kind: "link", message } : { kind: "message", message };
};

export const parseSlackEventDecision = (value: unknown): SlackEventDecision => {
  const legacy = legacyDecisionSchema.safeParse(value);
  if (legacy.success) {
    return legacy.data;
  }
  try {
    return Schema.decodeUnknownSync(SlackPrimaryDecisionSchema, {
      onExcessProperty: "error",
    })(value);
  } catch {
    throw new ChannelError(
      503,
      "unavailable",
      "The saved Slack decision is invalid."
    );
  }
};

const addressOf = (
  row: typeof channelConversation.$inferSelect
): EventAddress => ({
  agentId: id.agent(row.agentId),
  conversationId: id.conversation(row.conversationId),
  organizationId: id.organization(row.organizationId),
  sessionId: id.session(row.sessionId),
});

const eligibleTargets = async (
  tx: Transaction,
  addresses: readonly EventAddress[],
  organizationId: string,
  ownerPrincipalId: string
): Promise<EventAddress[]> => {
  if (addresses.length > 18) {
    throw new ChannelError(503, "unavailable", "Too many subscribed bots.");
  }
  const candidates = await Promise.all(
    addresses.map(async (address) => {
      const [row] = await tx
        .select()
        .from(channelConversation)
        .where(eq(channelConversation.conversationId, address.conversationId));
      if (
        !row ||
        row.organizationId !== organizationId ||
        row.ownerPrincipalId !== ownerPrincipalId ||
        row.organizationId !== address.organizationId ||
        row.agentId !== address.agentId ||
        row.sessionId !== address.sessionId
      ) {
        throw new ChannelError(
          403,
          "forbidden",
          "The subscribed bot belongs to another source."
        );
      }
      return row.retiredAt || row.engine !== "pi-identity-v1"
        ? null
        : row.agentId;
    })
  );
  const agents = new Set(candidates.filter((agentId) => agentId !== null));
  return await Promise.all(
    [...agents].map(async (agentId) =>
      addressOf(
        await resolvePrimaryConversationIn(tx, {
          agentId,
          organizationId,
          ownerPrincipalId,
        })
      )
    )
  );
};

export const resolveSlackEventDecision = async (
  database: Database,
  options: ChannelOptions,
  configuration: SlackConfiguration,
  payload: SlackCallback
) => {
  const input = classify(payload.event);
  const eventKey = `slack:${options.organizationId}:${configuration.appId}:${configuration.workspaceId}:${payload.event_id}`;
  const legacyDigest = await digest({
    agentId: configuration.agentId,
    callback: payload,
  });
  const primaryDigest = await digest({ version: 2, callback: payload });
  const readPrior = (prior: typeof channelSlackEventReceipt.$inferSelect) => {
    const decision = parseSlackEventDecision(prior.decision);
    if (
      prior.digest !==
      (decision.kind === "primary-events-v2" ? primaryDigest : legacyDigest)
    ) {
      throw new ChannelError(
        409,
        "digest-mismatch",
        "The Slack event changed."
      );
    }
    return {
      created: false,
      decision,
    };
  };
  const [existing] = await database
    .select()
    .from(channelSlackEventReceipt)
    .where(eq(channelSlackEventReceipt.eventKey, eventKey));
  if (existing) {
    return { ...readPrior(existing), eventKey, input };
  }
  const discoveredLink =
    input.kind === "message"
      ? await createIdentityRepository(database).resolveSlackLink(
          configuration.workspaceId,
          input.message.user
        )
      : undefined;
  const owner =
    discoveredLink?.organizationId === options.organizationId
      ? discoveredLink
      : undefined;
  const validThread =
    input.kind === "message" &&
    Schema.is(SlackThreadSchema)({
      workspaceId: configuration.workspaceId,
      channelId: input.message.channel,
      rootTimestamp: input.message.threadTs ?? input.message.ts,
    });
  let targets: readonly EventAddress[] = [];
  if (input.kind === "message" && owner && validThread) {
    if (!options.slackEvents) {
      throw new ChannelError(
        503,
        "unavailable",
        "Slack event routing is unavailable."
      );
    }
    targets = await options.slackEvents.discover({
      context: await contextByPrincipal(
        database,
        options.organizationId,
        owner.principalId
      ),
      thread: Schema.decodeUnknownSync(SlackThreadSchema)({
        workspaceId: configuration.workspaceId,
        channelId: input.message.channel,
        rootTimestamp: input.message.threadTs ?? input.message.ts,
      }),
    });
  }
  const result = await database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${eventKey}))`);
    const [prior] = await tx
      .select()
      .from(channelSlackEventReceipt)
      .where(eq(channelSlackEventReceipt.eventKey, eventKey));
    if (prior) {
      return readPrior(prior);
    }
    let decision: SlackEventDecision;
    if (input.kind === "message") {
      const link = await createIdentityRepository(tx).resolveSlackLink(
        configuration.workspaceId,
        input.message.user
      );
      if (!validThread) {
        decision = { kind: "ignored", reason: "unsupported" };
      } else if (owner) {
        if (
          !link ||
          link.organizationId !== options.organizationId ||
          link.principalId !== owner.principalId
        ) {
          throw new ChannelError(
            403,
            "forbidden",
            "The Slack account link changed during routing."
          );
        }
        const explicit = await eligibleTargets(
          tx,
          targets,
          options.organizationId,
          owner.principalId
        );
        const selected = explicit.length
          ? explicit
          : [
              addressOf(
                await resolvePrimaryConversationIn(tx, {
                  agentId: configuration.agentId,
                  organizationId: options.organizationId,
                  ownerPrincipalId: owner.principalId,
                })
              ),
            ];
        decision = Schema.decodeUnknownSync(SlackPrimaryDecisionSchema)({
          kind: "primary-events-v2",
          ownerPrincipalId: id.principal(owner.principalId),
          authority: {
            appId: configuration.appId,
            eventId: payload.event_id,
            userId: input.message.user,
            thread: {
              workspaceId: configuration.workspaceId,
              channelId: input.message.channel,
              rootTimestamp: input.message.threadTs ?? input.message.ts,
            },
          },
          text: input.message.text,
          targets: selected,
        });
      } else {
        decision = { kind: "ignored", reason: "unlinked" };
      }
    } else {
      decision = {
        kind: "ignored",
        reason: input.kind === "link" ? "link-command" : input.reason,
      };
    }
    await tx.insert(channelSlackEventReceipt).values({
      decision,
      digest:
        decision.kind === "primary-events-v2" ? primaryDigest : legacyDigest,
      eventKey,
    });
    return { created: true, decision };
  });
  return { ...result, eventKey, input };
};

export const readSlackEventTarget = async (
  database: Database,
  options: ChannelOptions,
  configuration: SlackConfiguration,
  decision: Extract<SlackEventDecision, { kind: "admit" }>,
  message: DirectMessage
) => {
  const link = await createIdentityRepository(database).resolveSlackLink(
    configuration.workspaceId,
    message.user
  );
  const { sourceEventAddress: address } = decision;
  const [conversation] = await database
    .select()
    .from(channelConversation)
    .where(eq(channelConversation.conversationId, address.conversationId));
  if (
    !link ||
    link.organizationId !== options.organizationId ||
    link.principalId !== decision.ownerPrincipalId ||
    !conversation ||
    conversation.organizationId !== options.organizationId ||
    conversation.organizationId !== address.organizationId ||
    conversation.ownerPrincipalId !== decision.ownerPrincipalId ||
    conversation.agentId !== address.agentId ||
    conversation.agentId !== configuration.agentId ||
    conversation.sessionId !== address.sessionId ||
    conversation.kind !== "slack" ||
    conversation.engine !== "pi-identity-v1" ||
    conversation.workspaceId !== configuration.workspaceId ||
    conversation.channelId !== message.channel ||
    conversation.slackUserId !== message.user ||
    conversation.rootTimestamp !== (message.threadTs ?? message.ts)
  ) {
    throw new ChannelError(
      403,
      "forbidden",
      "The saved Slack event target is no longer accessible."
    );
  }
  return conversation;
};
