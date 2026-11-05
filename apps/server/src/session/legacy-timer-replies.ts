import type { SlackConfiguration } from "@cerebro/channels/types";
import { Denied } from "@cerebro/contracts/failures";
import type { LegacyTimerReplyOrigin } from "@cerebro/contracts/timer-events";
import { withDatabase } from "@cerebro/db";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import { channelConversation } from "@cerebro/db/schema/agents";
import { eq } from "drizzle-orm";

import type { WorkerEnv } from "../bindings";

export const requireLegacyTimerDestination = async (
  env: WorkerEnv,
  configuration: SlackConfiguration,
  destination: LegacyTimerReplyOrigin
): Promise<void> => {
  const { source, authority, ownerPrincipalId } = destination;
  const valid = await withDatabase(env, async (database) => {
    const [row] = await database
      .select()
      .from(channelConversation)
      .where(eq(channelConversation.conversationId, source.conversationId));
    const link = await createIdentityRepository(database).resolveSlackLink(
      authority.thread.workspaceId,
      authority.userId
    );
    return (
      row &&
      row.kind === "slack" &&
      row.engine === "pi-identity-v1" &&
      !row.retiredAt &&
      row.organizationId === source.organizationId &&
      row.agentId === source.agentId &&
      row.sessionId === source.sessionId &&
      row.ownerPrincipalId === ownerPrincipalId &&
      row.workspaceId === authority.thread.workspaceId &&
      row.channelId === authority.thread.channelId &&
      row.rootTimestamp === authority.thread.rootTimestamp &&
      row.slackUserId === authority.userId &&
      link?.organizationId === source.organizationId &&
      link.principalId === ownerPrincipalId &&
      configuration.appId === authority.appId &&
      configuration.workspaceId === authority.thread.workspaceId
    );
  });
  if (!valid) {
    throw new Denied({
      code: "revoked",
      reason: "The legacy timer destination is no longer authorized.",
    });
  }
};
