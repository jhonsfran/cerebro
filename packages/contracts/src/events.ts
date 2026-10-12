import type {
  AgentId,
  ConversationId,
  OrganizationId,
  SessionId,
} from "./identity.ts";

export interface EventAddress {
  readonly organizationId: OrganizationId;
  readonly agentId: AgentId;
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
}
