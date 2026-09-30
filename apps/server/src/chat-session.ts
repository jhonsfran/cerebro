import { ChannelError } from "@cerebro/channels/types";
import type { Database } from "@cerebro/db";
import { session } from "@cerebro/db/schema/auth";
import { and, eq, gt } from "drizzle-orm";

export const requireChatSession = async (
  database: Database,
  identity: { readonly authSessionId: string; readonly userId: string }
): Promise<void> => {
  const [active] = await database
    .select({ id: session.id })
    .from(session)
    .where(
      and(
        eq(session.id, identity.authSessionId),
        eq(session.userId, identity.userId),
        gt(session.expiresAt, new Date())
      )
    )
    .limit(1);
  if (!active) {
    throw new ChannelError(401, "unauthorized", "Sign in to continue.");
  }
};
