import { useCallback, useEffect, useRef, useState } from "react";

import {
  assertCurrentAccess,
  currentAccessGeneration,
  encoded,
  mutate,
  productPath,
  request,
} from "./api";
import { operationFor } from "./intent";
import type { OperationIntent } from "./intent";
import { resolveWorkspaceSelection } from "./selection";
import type {
  AgentDetail,
  AgentSummary,
  ConversationReference,
  Setup,
} from "./types";
import {
  agentDetailSchema,
  agentListSchema,
  createdConversationSchema,
  conversationReferenceSchema,
  setupSchema,
} from "./types";
import type { WorkspaceView } from "./workspace-view";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "The request failed.";

export const useWorkspace = ({
  userId,
  conversationId,
  onConversation,
}: {
  userId: string;
  conversationId?: string;
  onConversation: (conversationId?: string) => void;
}) => {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [conversationReference, setConversationReference] =
    useState<ConversationReference | null>(null);
  const selectionRevision = useRef(0);
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [view, setView] = useState<WorkspaceView>({
    kind: "agent",
    tab: "conversation",
  });
  const [errorMessage, setErrorMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const setupIntent = useRef<OperationIntent | null>(null);
  const conversationIntent = useRef<OperationIntent | null>(null);
  useEffect(() => {
    const clear = () => {
      setAgents([]);
      setAgent(null);
      setConversationReference(null);
      selectionRevision.current += 1;
      setSelectedId("");
      setView({ kind: "agent", tab: "conversation" });
      setErrorMessage(
        "Access changed. Refresh the workspace to check your permissions."
      );
    };
    window.addEventListener("cerebro:access-cleared", clear);
    return () => window.removeEventListener("cerebro:access-cleared", clear);
  }, []);
  const loadAgents = useCallback(async () => {
    const generation = currentAccessGeneration();
    const list = await request(productPath("agents"), agentListSchema);
    assertCurrentAccess(generation);
    setAgents(list.agents);
    setSelectedId((current) => current || list.agents[0]?.agentId || "");
  }, []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const generation = currentAccessGeneration();
      try {
        const value = await request(productPath("setup"), setupSchema);
        if (!active) {
          return;
        }
        assertCurrentAccess(generation);
        setSetup(value);
        if (!value.setupRequired && value.principalId) {
          await loadAgents();
        }
      } catch (error) {
        if (active) {
          setErrorMessage(messageOf(error));
        }
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [loadAgents]);
  const principalId = setup?.principalId;
  useEffect(() => {
    if (!conversationId || !principalId) {
      return;
    }
    const controller = new AbortController();
    const revision = selectionRevision.current;
    const load = async () => {
      try {
        const reference = await request(
          productPath(`conversations/${encoded(conversationId)}`),
          conversationReferenceSchema,
          { signal: controller.signal }
        );
        if (
          controller.signal.aborted ||
          selectionRevision.current !== revision
        ) {
          return;
        }
        if (reference.conversationId !== conversationId) {
          setErrorMessage(
            "The conversation response does not match this page."
          );
          return;
        }
        setConversationReference(reference);
        setSelectedId(reference.agentId);
      } catch (error) {
        if (
          !controller.signal.aborted &&
          selectionRevision.current === revision
        ) {
          setErrorMessage(messageOf(error));
        }
      }
    };
    load();
    return () => controller.abort();
  }, [conversationId, principalId]);
  const refreshAgent = useCallback(async () => {
    if (selectedId) {
      const generation = currentAccessGeneration();
      const value = await request(
        productPath(`agents/${encoded(selectedId)}`),
        agentDetailSchema
      );
      assertCurrentAccess(generation);
      setAgent(value);
    }
  }, [selectedId]);
  useEffect(() => {
    let active = true;
    if (!selectedId) {
      return;
    }
    const load = async () => {
      const generation = currentAccessGeneration();
      try {
        const value = await request(
          productPath(`agents/${encoded(selectedId)}`),
          agentDetailSchema
        );
        if (active) {
          assertCurrentAccess(generation);
          setAgent(value);
        }
      } catch (error) {
        if (active) {
          setErrorMessage(messageOf(error));
        }
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [selectedId]);
  const claimSetup = async () => {
    setBusy(true);
    setErrorMessage("");
    try {
      const value = await mutate(
        productPath("setup"),
        {
          operationId: operationFor(setupIntent, { userId }),
          ...(bootstrapToken ? { bootstrapToken } : {}),
        },
        setupSchema
      );
      setSetup(value);
      setBootstrapToken("");
      await loadAgents();
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
    setBusy(false);
  };
  const startConversation = async () => {
    if (!selectedId) {
      return;
    }
    setBusy(true);
    setErrorMessage("");
    try {
      const value = await mutate(
        productPath("conversations"),
        {
          agentId: selectedId,
          operationId: operationFor(conversationIntent, {
            agentId: selectedId,
          }),
        },
        createdConversationSchema
      );
      onConversation(value.conversationId);
      conversationIntent.current = null;
      setView({ kind: "agent", tab: "conversation" });
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
    setBusy(false);
  };
  const { activeAgent, activeAgentId, selected, conversationPending } =
    resolveWorkspaceSelection(
      agents,
      agent,
      selectedId,
      conversationId,
      conversationReference
    );
  const selectAgent = (agentId: string) => {
    selectionRevision.current += 1;
    setConversationReference(null);
    onConversation();
    setSelectedId(agentId);
    setView({ kind: "agent", tab: "configuration" });
  };
  const agentSaved = async (agentId: string) => {
    const generation = currentAccessGeneration();
    await loadAgents();
    assertCurrentAccess(generation);
    setSelectedId(agentId);
    setView({ kind: "agent", tab: "configuration" });
    const value = await request(
      productPath(`agents/${encoded(agentId)}`),
      agentDetailSchema
    );
    assertCurrentAccess(generation);
    setAgent(value);
  };
  return {
    setup,
    bootstrapToken,
    setBootstrapToken,
    agents,
    view,
    setView,
    errorMessage,
    busy,
    activeAgent,
    activeAgentId,
    selected,
    conversationPending,
    claimSetup,
    startConversation,
    refreshAgent,
    selectAgent,
    agentSaved,
  };
};
