import { assertQueuePayloadSize } from "@cerebro/channels/queue-payload";
import { contextByPrincipal } from "@cerebro/channels/security";
import {
  Denied,
  NotFound,
  Unavailable,
  toContractFailure,
} from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type {
  ContentDependencies,
  AgentDefinition,
} from "@cerebro/contracts/session";
import { ChatDecisionReceipt } from "@cerebro/contracts/session-service";
import { TeamApprovalDecisionSchema } from "@cerebro/contracts/team-events";
import type { TeamApprovalDecision } from "@cerebro/contracts/team-events";
import { resolveWorkLimits, workCellName } from "@cerebro/contracts/work";
import type { TeamDefaults } from "@cerebro/contracts/work";
import { withDatabase } from "@cerebro/db";
import type { channelConversation } from "@cerebro/db/schema/agents";
import type { CoordinationServices } from "@cerebro/runtime/coordinator-work";
import { Schema } from "effect";

import type { WorkerEnv } from "../bindings";
import { runtimeConfiguration } from "../config";
import { signSessionRequest } from "./proof";

const decisionFailure = (status: number) => {
  if (status === 401 || status === 403) {
    return new Denied({
      code: "revoked",
      reason: "The Team no longer accepts this decision.",
    });
  }
  if (status === 404) {
    return new NotFound({ resource: "Tool approval" });
  }
  return new Unavailable({ reason: "The Team approval is unavailable." });
};

// Synchronous, so the person sees the Team's final state. The Team side is idempotent.
const relayDecision = async (
  env: WorkerEnv,
  decision: TeamApprovalDecision
) => {
  const { key, sourceEventAddress } = decision.work;
  const identity = {
    organizationId: key.organizationId,
    ownerPrincipalId: key.ownerPrincipalId,
  };
  const body = JSON.stringify(decision);
  let response: Response;
  try {
    const context = await withDatabase(env, (database) =>
      contextByPrincipal(
        database,
        identity.organizationId,
        identity.ownerPrincipalId
      )
    );
    const proof = await signSessionRequest(
      sourceEventAddress,
      context,
      "/approval-decision",
      body,
      runtimeConfiguration(env).gatewaySigningKey,
      identity
    );
    response = await env.TEAM.get(env.TEAM.idFromName(workCellName(key))).fetch(
      new Request("https://team.internal/approval-decision", {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "x-cerebro-session-proof": proof,
        },
      })
    );
  } catch (error) {
    throw toContractFailure(error, "The Team approval is unavailable.");
  }
  if (!response.ok) {
    throw decisionFailure(response.status);
  }
  try {
    return Schema.decodeUnknownSync(ChatDecisionReceipt, {
      onExcessProperty: "error",
    })(await response.json());
  } catch {
    throw new Unavailable({ reason: "Invalid Team approval response." });
  }
};

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
  decideApproval: (work, approvalId, decision) =>
    relayDecision(
      options.env,
      Schema.decodeUnknownSync(TeamApprovalDecisionSchema)({
        work,
        approvalId,
        decision,
      })
    ),
});
