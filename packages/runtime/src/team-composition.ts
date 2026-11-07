import type { EventAddress } from "@cerebro/contracts/events";
import { InvalidInput } from "@cerebro/contracts/failures";
import type { AgentDefinition } from "@cerebro/contracts/session";
import type { WorkAdmission } from "@cerebro/contracts/work";

export type TeamRoleKind = "lead" | "worker";

export const LEAD_ROLE_INSTRUCTIONS =
  "You lead a background team working on one bounded request. The first message is the goal. Split it into independent tasks and call delegate_worker once per task, several in the same turn so the workers run in parallel, then combine the answers into one complete final answer. The person is not in this conversation; do not ask them anything. A tool that needs approval waits while the person decides in their own conversation; if they deny it, do not call it again. Your final message is the report.";
export const WORKER_ROLE_INSTRUCTIONS =
  "You are a worker in a background team. Complete the assigned task with the tools you have. A tool that needs approval waits while the person decides; if they deny it, do not call it again. Do not delegate, schedule, or address the person. Your final message is the answer.";
const ROLE_INSTRUCTIONS: Record<TeamRoleKind, string> = {
  lead: LEAD_ROLE_INSTRUCTIONS,
  worker: WORKER_ROLE_INSTRUCTIONS,
};

export const teamRoleKind = (
  work: WorkAdmission,
  index: number
): TeamRoleKind => {
  if (!Number.isInteger(index) || index < 0 || index > work.limits.maxTurns) {
    throw new InvalidInput({ reason: "Invalid private role slot." });
  }
  return index === 0 ? "lead" : "worker";
};

export const teamRoleDefinition = (
  agent: AgentDefinition,
  role: TeamRoleKind
): AgentDefinition => ({
  organizationId: agent.organizationId,
  agentId: agent.agentId,
  version: agent.version,
  instructions: `${ROLE_INSTRUCTIONS[role]}\n\n${agent.instructions}`,
  model: agent.model,
  enabledToolIds: agent.enabledToolIds,
  grants: agent.grants,
});

export const requireRoleConfiguration = (
  work: WorkAdmission,
  {
    agent,
    address,
  }: { readonly agent: AgentDefinition; readonly address: EventAddress }
): void => {
  if (
    agent.agentId !== work.agent.agentId ||
    agent.version !== work.agent.agentVersion ||
    agent.organizationId !== work.key.organizationId ||
    address.agentId !== work.agent.agentId ||
    address.organizationId !== work.key.organizationId
  ) {
    throw new InvalidInput({
      reason: "The team role configuration differs from its saved pin.",
    });
  }
};
