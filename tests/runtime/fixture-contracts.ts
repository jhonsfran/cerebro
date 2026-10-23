import { z } from "zod";

import type { EventAddress } from "../../packages/contracts/src/events.ts";
import { id } from "../../packages/contracts/src/identity.ts";

export const fixtureAddress = z.object({
  agentId: z.string().min(1),
  conversationId: z.string().min(1),
  organizationId: z.string().min(1),
  sessionId: z.string().min(1),
});
export const forkOrigin = z.object({
  address: fixtureAddress,
  agentVersion: z.number().int().positive(),
  entryId: z.string().min(1),
});
export const requestAddress = async (
  request: Request
): Promise<EventAddress> => {
  const { address } = z
    .object({ address: fixtureAddress })
    .parse(await request.clone().json());
  return {
    agentId: id.agent(address.agentId),
    conversationId: id.conversation(address.conversationId),
    organizationId: id.organization(address.organizationId),
    sessionId: id.session(address.sessionId),
  };
};
