import type { EventAddress } from "../../packages/contracts/src/events.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type {
  ExecutionContext,
  Principal,
} from "../../packages/contracts/src/identity.ts";
import type { ToolInvocation } from "../../packages/contracts/src/tools.ts";

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

export const activeDeniedUser: Principal = {
  id: id.principal("user-active-denied"),
  kind: "human",
  organizationId: fixtureOrganizationId,
  state: "active",
};

export const serviceActor: Principal = {
  id: id.principal("service-1"),
  kind: "service",
  organizationId: fixtureOrganizationId,
  state: "active",
};

export const allowedContext: ExecutionContext = { actor: allowedUser };
export const deniedContext: ExecutionContext = { actor: deniedUser };
export const activeDeniedContext: ExecutionContext = {
  actor: activeDeniedUser,
};

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

export const userEvent: EventAddress & { readonly context: ExecutionContext } =
  {
    agentId: fixtureAgentId,
    context: allowedContext,
    conversationId: fixtureConversationId,
    organizationId: fixtureOrganizationId,
    sessionId: fixtureSessionId,
  };

export const unknownOutcomeInvocation: ToolInvocation = {
  agentId: fixtureAgentId,
  argumentDigest: id.digest(
    "sha256:bb0b880e67c4945ee042df806a395b2d49580920b2c559d635af142a67e0a9e2"
  ),
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
