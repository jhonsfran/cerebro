import { assertQueuePayloadSize } from "@cerebro/channels/queue-payload";
import { id } from "@cerebro/contracts/identity";
import type {
  ContentDependencies,
  AgentDefinition,
} from "@cerebro/contracts/session";
import { resolveWorkLimits } from "@cerebro/contracts/work";
import type { TeamDefaults } from "@cerebro/contracts/work";
import type { channelConversation } from "@cerebro/db/schema/agents";
import type { CoordinationServices } from "@cerebro/runtime/coordinator-work";

import type { WorkerEnv } from "../bindings";

export const createCoordinatorServices = (options: {
  readonly env: WorkerEnv;
  readonly agent: AgentDefinition;
  readonly conversation: typeof channelConversation.$inferSelect;
  readonly teamDefaults: TeamDefaults;
  readonly contentDependencies: () => Promise<ContentDependencies>;
}): CoordinationServices => ({
  ownerPrincipalId: id.principal(options.conversation.ownerPrincipalId),
  agent: {
    agentId: options.agent.agentId,
    agentVersion: options.agent.version,
  },
  limits: resolveWorkLimits(options.agent, options.teamDefaults),
  contentDependencies: options.contentDependencies,
  sendCommand: async (command) => {
    assertQueuePayloadSize(command);
    await options.env.TEAM_COMMANDS.send(command, { contentType: "json" });
  },
});
