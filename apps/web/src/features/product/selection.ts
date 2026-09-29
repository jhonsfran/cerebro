import type { AgentDetail, AgentSummary, ConversationReference } from "./types";

export const resolveWorkspaceSelection = (
  agents: readonly AgentSummary[],
  detail: AgentDetail | null,
  selectedId: string,
  conversationId: string | undefined,
  reference: ConversationReference | null
) => {
  const bound = reference?.conversationId === conversationId ? reference : null;
  const activeAgentId = conversationId ? (bound?.agentId ?? "") : selectedId;
  const selected = agents.find((entry) => entry.agentId === activeAgentId);
  const activeAgent = detail?.agentId === activeAgentId ? detail : null;
  return {
    activeAgent,
    activeAgentId,
    conversationPending: Boolean(conversationId && (!bound || !selected)),
    selected,
  };
};
