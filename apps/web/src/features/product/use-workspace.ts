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
import { conversationReference, resolveWorkspaceSelection } from "./selection";
import type { ConversationSelection } from "./selection";
import type {
  AgentDetail,
  AgentSummary,
  ConversationReference,
  Setup,
} from "./types";
import {
  agentDetailSchema,
  agentListSchema,
  conversationSchema,
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
  const [conversationSelection, setConversationSelection] =
    useState<ConversationSelection>({ kind: "pending", conversationId });
  const [openedConversation, setOpenedConversation] =
    useState<ConversationReference | null>(null);
  const openingRequest = useRef<AbortController | null>(null);
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
  const changeView = useCallback((next: WorkspaceView) => {
    selectionRevision.current += 1;
    openingRequest.current?.abort();
    openingRequest.current = null;
    setBusy(false);
    setView(next);
  }, []);
  useEffect(() => {
    const clear = () => {
      setAgents([]);
      setAgent(null);
      setSetup(null);
      setConversationSelection({ kind: "pending", conversationId: undefined });
      setOpenedConversation(null);
      setSelectedId("");
      changeView({ kind: "agent", tab: "conversation" });
      setErrorMessage(
        "Access changed. Refresh the workspace to check your permissions."
      );
    };
    window.addEventListener("cerebro:access-cleared", clear);
    return () => {
      window.removeEventListener("cerebro:access-cleared", clear);
      selectionRevision.current += 1;
      openingRequest.current?.abort();
    };
  }, [changeView]);
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
  const organizationId = setup?.organizationId;
  const visibleConversationId =
    view.kind === "agent" && view.tab === "conversation"
      ? conversationId
      : undefined;
  const reference = conversationReference(conversationSelection);
  const selectedConversationId =
    conversationSelection.kind === "pending"
      ? conversationSelection.conversationId
      : reference?.conversationId;
  if (selectedConversationId !== conversationId) {
    setConversationSelection({ kind: "pending", conversationId });
  } else if (
    !visibleConversationId &&
    conversationSelection.kind === "loaded"
  ) {
    const { agentId, sessionId } = conversationSelection.loaded.conversation;
    setConversationSelection({
      kind: "reference",
      reference: {
        agentId,
        conversationId:
          conversationSelection.loaded.conversation.conversationId,
        sessionId,
      },
    });
  }
  const loadedConversation =
    conversationSelection.kind === "loaded"
      ? conversationSelection.loaded
      : null;
  const currentConversation =
    selectedConversationId === visibleConversationId &&
    loadedConversation?.userId === userId &&
    loadedConversation.principalId === principalId &&
    loadedConversation.accessGeneration === currentAccessGeneration() &&
    loadedConversation.conversation.snapshot.address.organizationId ===
      organizationId
      ? loadedConversation
      : null;
  useEffect(() => {
    selectionRevision.current += 1;
    const revision = selectionRevision.current;
    openingRequest.current?.abort();
    if (!visibleConversationId || !principalId || !organizationId) {
      return;
    }
    const controller = new AbortController();
    const generation = currentAccessGeneration();
    const expected =
      openedConversation?.conversationId === visibleConversationId
        ? openedConversation
        : null;
    const load = async () => {
      try {
        const conversation = await request(
          productPath(`conversations/${encoded(visibleConversationId)}`),
          conversationSchema,
          { signal: controller.signal }
        );
        if (
          controller.signal.aborted ||
          selectionRevision.current !== revision
        ) {
          return;
        }
        assertCurrentAccess(generation);
        if (
          conversation.conversationId !== visibleConversationId ||
          conversation.snapshot.address.organizationId !== organizationId ||
          (expected &&
            (conversation.agentId !== expected.agentId ||
              conversation.sessionId !== expected.sessionId))
        ) {
          setErrorMessage("The conversation does not belong to this agent.");
          return;
        }
        setConversationSelection({
          kind: "loaded",
          loaded: {
            userId,
            principalId,
            accessGeneration: generation,
            selectionRevision: revision,
            conversation,
          },
        });
        setSelectedId(conversation.agentId);
        setErrorMessage("");
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
  }, [
    visibleConversationId,
    principalId,
    organizationId,
    userId,
    openedConversation,
  ]);
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
  const openConversation = async () => {
    if (!selectedId) {
      return;
    }
    setBusy(true);
    setErrorMessage("");
    const generation = currentAccessGeneration();
    const revision = selectionRevision.current;
    const controller = new AbortController();
    openingRequest.current?.abort();
    openingRequest.current = controller;
    try {
      const value = await request(
        productPath("conversations"),
        conversationReferenceSchema,
        {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            agentId: selectedId,
            operationId: operationFor(conversationIntent, {
              agentId: selectedId,
            }),
          }),
        }
      );
      assertCurrentAccess(generation);
      if (revision === selectionRevision.current) {
        const sameConversation =
          currentConversation?.conversation.conversationId ===
          value.conversationId;
        if (
          value.agentId !== selectedId ||
          (sameConversation &&
            (currentConversation.conversation.agentId !== value.agentId ||
              currentConversation.conversation.sessionId !== value.sessionId))
        ) {
          setErrorMessage("The conversation does not belong to this agent.");
        } else {
          if (!sameConversation) {
            setOpenedConversation(value);
          }
          onConversation(value.conversationId);
          conversationIntent.current = null;
          setView({ kind: "agent", tab: "conversation" });
        }
      }
    } catch (error) {
      if (
        !controller.signal.aborted &&
        revision === selectionRevision.current &&
        generation === currentAccessGeneration()
      ) {
        setErrorMessage(messageOf(error));
      }
    }
    if (openingRequest.current === controller) {
      openingRequest.current = null;
      setBusy(false);
    }
  };
  const { activeAgent, activeAgentId, selected, conversationPending } =
    resolveWorkspaceSelection(
      agents,
      agent,
      selectedId,
      conversationId,
      selectedConversationId === conversationId ? reference : null
    );
  const selectAgent = (agentId: string) => {
    changeView({ kind: "agent", tab: "configuration" });
    setConversationSelection({ kind: "pending", conversationId: undefined });
    setOpenedConversation(null);
    onConversation();
    setSelectedId(agentId);
  };
  const agentSaved = async (agentId: string) => {
    const generation = currentAccessGeneration();
    await loadAgents();
    assertCurrentAccess(generation);
    setSelectedId(agentId);
    changeView({ kind: "agent", tab: "configuration" });
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
    setView: changeView,
    errorMessage,
    busy,
    activeAgent,
    activeAgentId,
    selected,
    conversationPending:
      conversationPending ||
      Boolean(visibleConversationId && !currentConversation),
    loadedConversation: currentConversation,
    claimSetup,
    openConversation,
    refreshAgent,
    selectAgent,
    agentSaved,
  };
};
