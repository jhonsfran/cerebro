import type { EventEnvelope } from "../events.ts";
import { id } from "../identity.ts";
import type { ExecutionContext, Principal } from "../identity.ts";
import type { BudgetReservation } from "../policy.ts";
import type { PortResult } from "../port.ts";
import type { ToolExecution, ToolInvocation } from "../tools.ts";

export const fixtureOrganizationId = id.organization("organization-1");
export const fixtureAgentId = id.agent("agent-1");
export const fixtureSessionId = id.session("session-1");
export const fixtureConversationId = id.conversation("conversation-1");
export const fixtureRunId = id.run("run-1");
export const fixtureToolId = id.tool("tool-1");

export const allowedUser: Principal = {
  id: id.principal("user-allowed"),
  kind: "human",
  organizationId: fixtureOrganizationId,
  state: "active",
};

export const deniedUser: Principal = {
  id: id.principal("user-denied"),
  kind: "human",
  organizationId: fixtureOrganizationId,
  state: "disabled",
};

export const serviceActor: Principal = {
  id: id.principal("service-1"),
  kind: "service",
  organizationId: fixtureOrganizationId,
  state: "active",
};

export const allowedContext: ExecutionContext = { actor: allowedUser };
export const deniedContext: ExecutionContext = { actor: deniedUser };

export const expiredDelegationContext: ExecutionContext = {
  actor: serviceActor,
  delegation: {
    actorId: serviceActor.id,
    expiresAt: 1_700_000_000_000,
    id: id.delegation("delegation-expired"),
    organizationId: fixtureOrganizationId,
    representedId: allowedUser.id,
  },
  represented: allowedUser,
};

export const userEvent: EventEnvelope = {
  agentId: fixtureAgentId,
  context: allowedContext,
  conversationId: fixtureConversationId,
  event: {
    payload: { text: "Summarize the support issue." },
    type: "user.message",
  },
  eventId: id.event("event-1"),
  occurredAt: 1_800_000_000_000,
  organizationId: fixtureOrganizationId,
  payloadDigest: id.digest("sha256:user-message"),
  schemaVersion: 1,
  sessionId: fixtureSessionId,
};

export const duplicateEvent: EventEnvelope = {
  ...userEvent,
};

export const unknownOutcomeInvocation: ToolInvocation = {
  agentId: fixtureAgentId,
  argumentDigest: id.digest("sha256:tool-arguments"),
  arguments: { ticket: "support-1" },
  context: allowedContext,
  operationId: id.operation("tool-operation-1"),
  organizationId: fixtureOrganizationId,
  state: "unknown-outcome",
  tool: {
    connectorId: "fixture-connector",
    effect: "write",
    id: fixtureToolId,
    version: "1",
  },
};

export const unknownToolOutcome: PortResult<ToolExecution> = {
  operationId: unknownOutcomeInvocation.operationId,
  reason:
    "The provider may have completed the effect before the connection failed.",
  status: "unknown-outcome",
};

export const depletedBudget: PortResult<BudgetReservation> = {
  code: "budget-exhausted",
  reason: "No capacity remains for this organization.",
  status: "denied",
};
