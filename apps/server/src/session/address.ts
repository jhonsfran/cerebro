import type { EventAddress } from "@cerebro/contracts/events";
import { Denied, tryAdapter } from "@cerebro/contracts/failures";
import { withDatabase } from "@cerebro/db";
import { channelConversation } from "@cerebro/db/schema/agents";
import { and, eq } from "drizzle-orm";

import type { WorkerEnv } from "../bindings";
import type { SessionIdentity } from "./proof";

export const resolveSessionAddress = (
  env: WorkerEnv,
  address: EventAddress,
  identity: SessionIdentity
) =>
  tryAdapter(() =>
    withDatabase(env, async (database) => {
      const [row] = await database
        .select()
        .from(channelConversation)
        .where(
          and(
            eq(channelConversation.organizationId, address.organizationId),
            eq(channelConversation.agentId, address.agentId),
            eq(channelConversation.conversationId, address.conversationId),
            eq(channelConversation.sessionId, address.sessionId)
          )
        );
      if (
        !row ||
        row.engine !== "pi-identity-v1" ||
        row.retiredAt ||
        row.organizationId !== identity.organizationId ||
        row.ownerPrincipalId !== identity.ownerPrincipalId
      ) {
        throw new Denied({
          code: "unauthorized",
          reason: "The identity does not own this active conversation.",
        });
      }
      return { address, conversation: row };
    })
  );
