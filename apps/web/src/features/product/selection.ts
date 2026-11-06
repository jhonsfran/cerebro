import type {
  AgentDetail,
  AgentSummary,
  ConversationReference,
  LoadedConversation,
} from "./types";

export type ConversationSelection =
  | { readonly kind: "pending"; readonly conversationId: string | undefined }
  | { readonly kind: "reference"; readonly reference: ConversationReference }
  | { readonly kind: "loaded"; readonly loaded: LoadedConversation };

export const conversationReference = (
  selection: ConversationSelection
): ConversationReference | null => {
  switch (selection.kind) {
    case "pending": {
      return null;
    }
    case "reference": {
      return selection.reference;
    }
    case "loaded": {
      return selection.loaded.conversation;
    }
    default: {
      const exhaustive: never = selection;
      return exhaustive;
    }
  }
};

export const resolveWorkspaceSelection = (
  agents: readonly AgentSummary[],
  detail: AgentDetail | null,
  selectedId: string,
  conversationId: string | undefined,
  conversation: ConversationReference | null
) => {
  const bound =
    conversation?.conversationId === conversationId ? conversation : null;
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
