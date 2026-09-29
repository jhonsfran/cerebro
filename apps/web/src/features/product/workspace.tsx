import { useCallback, useEffect, useRef, useState } from "react";

import { client } from "../../utils/orpc";
import {
  assertCurrentAccess,
  currentAccessGeneration,
  encoded,
  mutate,
  ProductError,
  productPath,
  request,
} from "./api";
import { ConversationPanel } from "./conversation";
import { operationFor } from "./intent";
import type { OperationIntent } from "./intent";
import { resolveWorkspaceSelection } from "./selection";
import type {
  AccessAction,
  AgentDetail,
  AgentSummary,
  Budget,
  ConversationReference,
  Grant,
  Setup,
} from "./types";
import {
  accessMutationSchema,
  agentDetailSchema,
  agentListSchema,
  budgetSchema,
  createdConversationSchema,
  conversationReferenceSchema,
  savedAgentSchema,
  setupSchema,
  slackLinkSchema,
} from "./types";

const readBudget = async (): Promise<Budget | null> => {
  try {
    return await request(
      productPath("budget"),
      budgetSchema,
      undefined,
      "optional-budget"
    );
  } catch (error) {
    if (error instanceof ProductError && error.status === 403) {
      return null;
    }
    throw error;
  }
};

type Tab = "conversation" | "configuration" | "access";

const saveLabel = (busy: boolean, editing: boolean): string => {
  if (busy) {
    return "Saving...";
  }
  return editing ? "Publish new version" : "Create agent";
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "The request failed.";

const AgentEditor = ({
  agent,
  setup,
  onSaved,
  onCancel,
}: {
  agent: AgentDetail | null;
  setup: Setup;
  onSaved: (agentId: string) => Promise<void>;
  onCancel: () => void;
}) => {
  const [name, setName] = useState(agent?.name ?? "");
  const [instructions, setInstructions] = useState(
    agent?.definition.instructions ??
      "Answer company questions. Cite each source. Ask for approval before a controlled action."
  );
  const [model, setModel] = useState(
    agent?.definition.model ?? "fixture-model"
  );
  const [connectors, setConnectors] = useState(
    agent?.definition.enabledToolIds ?? ["fixture-read"]
  );
  const [grantReads, setGrantReads] = useState(
    agent
      ? agent.definition.grants.some(
          (grant) => grant.resource.kind === "tool" && grant.action === "read"
        )
      : true
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const choices = agent?.connectorChoices ?? [
    { id: "fixture-read", label: "Company knowledge · local fixture" },
  ];
  const modelChoices = agent?.modelChoices ?? [
    { id: "fixture-model", label: "Deterministic local fixture" },
  ];
  const saveIntent = useRef<OperationIntent | null>(null);
  const save = async () => {
    setBusy(true);
    setErrorMessage("");
    const existingGrants =
      agent?.definition.grants.filter(
        (grant) => !(grant.resource.kind === "tool" && grant.action === "read")
      ) ?? [];
    const grants: Grant[] = grantReads
      ? [
          ...existingGrants,
          ...connectors.map((connectorId): Grant => ({
            action: "read",
            resource: {
              id: connectorId,
              kind: "tool",
              organizationId: setup.organizationId,
            },
          })),
        ]
      : existingGrants;
    const input = {
      enabledToolIds: connectors,
      grants,
      instructions: instructions.trim(),
      model,
      name: name.trim(),
      ...(agent ? { expectedVersion: agent.definition.version } : {}),
    };
    try {
      const saved = await mutate(
        productPath(agent ? `agents/${encoded(agent.agentId)}` : "agents"),
        { ...input, operationId: operationFor(saveIntent, input) },
        savedAgentSchema,
        agent ? "PUT" : "POST"
      );
      await onSaved(saved.agentId);
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
    setBusy(false);
  };
  return (
    <section className="settings-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Agent configuration</p>
          <h2>{agent ? `Edit ${agent.name}` : "Create an agent"}</h2>
        </div>
        {agent ? (
          <span className="status-pill">
            Version {agent.definition.version}
          </span>
        ) : null}
      </div>
      <p className="muted-text">
        Each save publishes a new version. Earlier versions remain available for
        existing runs.
      </p>
      {errorMessage ? (
        <p className="error-banner" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <form
        className="agent-form"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <label htmlFor="agent-name">Agent name</label>
        <input
          id="agent-name"
          autoComplete="off"
          placeholder="Company assistant"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          required
        />
        <label htmlFor="agent-instructions">Instructions</label>
        <textarea
          id="agent-instructions"
          rows={6}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          required
        />
        <label htmlFor="agent-model">Model</label>
        <select
          id="agent-model"
          value={model}
          onChange={(event) => setModel(event.target.value)}
        >
          {modelChoices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
        <fieldset>
          <legend>Connectors</legend>
          <p className="muted-text">Enable the sources this agent can use.</p>
          {choices.map((choice) => (
            <label className="checkbox-row" key={choice.id}>
              <input
                type="checkbox"
                checked={connectors.includes(choice.id)}
                onChange={(event) =>
                  setConnectors((current) =>
                    event.target.checked
                      ? [...current, choice.id]
                      : current.filter((id) => id !== choice.id)
                  )
                }
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Execution grants</legend>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={grantReads}
              onChange={(event) => setGrantReads(event.target.checked)}
            />
            <span>Permit reads through the selected connectors</span>
          </label>
          <p className="muted-text">
            A connector selection does not replace a grant. Current user access
            still applies to every request.
          </p>
        </fieldset>
        <div className="button-row">
          <button
            className="primary-button"
            disabled={busy || !name.trim() || !instructions.trim()}
            type="submit"
          >
            {saveLabel(busy, Boolean(agent))}
          </button>
          <button
            className="quiet-button"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
};

const AccessPanel = ({
  agent,
  refresh,
}: {
  agent: AgentDetail;
  refresh: () => Promise<void>;
}) => {
  const [errorMessage, setErrorMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const accessIntent = useRef<OperationIntent | null>(null);
  const change = async (principalId: string, actions: AccessAction[]) => {
    setBusy(true);
    setErrorMessage("");
    try {
      await mutate(
        productPath(
          `agents/${encoded(agent.agentId)}/access/${encoded(principalId)}`
        ),
        {
          actions,
          operationId: operationFor(accessIntent, {
            actions,
            agentId: agent.agentId,
            principalId,
          }),
        },
        accessMutationSchema,
        "PUT"
      );
      await refresh();
      accessIntent.current = null;
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
    setBusy(false);
  };
  return (
    <section className="settings-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Access management</p>
          <h2>Who can use {agent.name}?</h2>
        </div>
      </div>
      <p className="muted-text">
        Changes apply to the next action in web and linked Slack conversations.
      </p>
      {errorMessage ? (
        <p className="error-banner" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <div className="access-table">
        <div className="access-row access-labels">
          <span>Company principal</span>
          <span>Read</span>
          <span>Execute</span>
          <span>Approve</span>
        </div>
        {agent.access.map((entry) => (
          <div className="access-row" key={entry.principalId}>
            <div>
              <strong>{entry.name}</strong>
              <small>{entry.principalId}</small>
            </div>
            {(["read", "execute", "approve"] as const).map((action) => (
              <label key={action}>
                <span className="sr-only">
                  {action} access for {entry.name}
                </span>
                <input
                  type="checkbox"
                  checked={entry.actions.includes(action)}
                  disabled={busy}
                  onChange={(event) =>
                    change(
                      entry.principalId,
                      event.target.checked
                        ? [...entry.actions, action]
                        : entry.actions.filter((value) => value !== action)
                    )
                  }
                />
              </label>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
};

interface WorkspaceBodyProps {
  setup: Setup | null;
  selected: AgentSummary | undefined;
  agent: AgentDetail | null;
  creating: boolean;
  tab: Tab;
  busy: boolean;
  conversationId: string | undefined;
  conversationPending: boolean;
  userId: string;
  setTab: (tab: Tab) => void;
  setCreating: (creating: boolean) => void;
  claimSetup: () => Promise<void>;
  startConversation: () => Promise<void>;
  refreshAgent: () => Promise<void>;
  onSaved: (agentId: string) => Promise<void>;
}
const tabLabels = {
  access: "Access",
  configuration: "Configuration",
  conversation: "Conversation",
};
const WelcomePanel = ({
  setup,
  selected,
  busy,
  startConversation,
  create,
}: {
  setup: Setup;
  selected: AgentSummary | undefined;
  busy: boolean;
  startConversation: () => Promise<void>;
  create: () => void;
}) => (
  <section className="welcome-panel">
    <div className="welcome-grid" aria-hidden="true" />
    <p className="eyebrow">Ask. Verify. Continue.</p>
    <h2>
      Answers with sources.
      <br />
      Actions with control.
    </h2>
    <p>
      Choose an agent and start a private conversation. Review its sources,
      tools, and approval requests in one place.
    </p>
    {selected ? (
      <button
        className="primary-button"
        disabled={busy}
        type="button"
        onClick={startConversation}
      >
        Start a conversation
      </button>
    ) : null}
    {!selected && setup.owner ? (
      <button className="primary-button" type="button" onClick={create}>
        Create your first agent
      </button>
    ) : null}
    {setup.mode === "fixture" ? (
      <p className="fixture-note">
        Local fixture mode uses deterministic answers and test sources.
      </p>
    ) : null}
  </section>
);
const WorkspaceBody = (props: WorkspaceBodyProps) => {
  const {
    setup,
    selected,
    agent,
    creating,
    tab,
    busy,
    conversationId,
    conversationPending,
    userId,
    setTab,
    setCreating,
    claimSetup,
    startConversation,
    refreshAgent,
    onSaved,
  } = props;
  if (!setup) {
    return (
      <section className="welcome-panel">
        <h2>Loading your workspace...</h2>
      </section>
    );
  }
  if (setup.setupRequired) {
    return (
      <section className="welcome-panel">
        <p className="eyebrow">Local fixture setup</p>
        <h2>Set up your company assistant.</h2>
        <p>
          The first owner configures agents and company access. The database
          permits one owner claim.
        </p>
        <button
          className="primary-button"
          disabled={busy || setup.mode !== "fixture"}
          type="button"
          onClick={claimSetup}
        >
          {busy ? "Setting up..." : "Set up local workspace"}
        </button>
      </section>
    );
  }
  if (!setup.principalId) {
    return (
      <section className="welcome-panel">
        <h2>Company access is required.</h2>
        <p>
          Ask the installation owner to provision your company principal and
          grant access.
        </p>
      </section>
    );
  }
  let content = (
    <WelcomePanel
      setup={setup}
      selected={selected}
      busy={busy}
      startConversation={startConversation}
      create={() => {
        setCreating(true);
        setTab("configuration");
      }}
    />
  );
  if (creating) {
    content = (
      <AgentEditor
        key="new"
        agent={null}
        setup={setup}
        onSaved={onSaved}
        onCancel={() => {
          setCreating(false);
          setTab("conversation");
        }}
      />
    );
  } else if (tab === "configuration" && selected?.canManage) {
    content =
      agent?.agentId === selected.agentId ? (
        <AgentEditor
          key={`${agent.agentId}:${agent.definition.version}`}
          agent={agent}
          setup={setup}
          onSaved={onSaved}
          onCancel={() => setTab("conversation")}
        />
      ) : (
        <p className="muted-text">Loading agent configuration...</p>
      );
  } else if (tab === "access" && agent) {
    content = <AccessPanel agent={agent} refresh={refreshAgent} />;
  } else if (tab === "conversation" && conversationPending) {
    content = (
      <p className="muted-text">Loading the agent for this conversation...</p>
    );
  } else if (tab === "conversation" && conversationId && selected) {
    content = (
      <ConversationPanel
        key={conversationId}
        conversationId={conversationId}
        userId={userId}
        agentId={selected.agentId}
        agentName={selected.name}
        fixture={setup.mode === "fixture"}
      />
    );
  }
  return (
    <>
      <nav className="workspace-tabs" aria-label="Agent views">
        {(["conversation", "configuration", "access"] as const).map((value) => (
          <button
            className={tab === value ? "active" : ""}
            key={value}
            type="button"
            disabled={value === "access" && !selected?.canManage}
            onClick={() => {
              setTab(value);
              if (value !== "configuration") {
                setCreating(false);
              }
            }}
          >
            {tabLabels[value]}
          </button>
        ))}
      </nav>
      {content}
    </>
  );
};

const WorkspaceHeader = ({
  selected,
  creating,
  busy,
  pending,
  onNew,
}: {
  selected: AgentSummary | undefined;
  creating: boolean;
  busy: boolean;
  pending: boolean;
  onNew: () => Promise<void>;
}) => (
  <header className="workspace-header">
    <div>
      <p className="eyebrow">Company workspace</p>
      <h1>
        {creating
          ? "A new assistant"
          : (selected?.name ?? "Your company, connected.")}
      </h1>
    </div>
    {selected ? (
      <button
        className="primary-button"
        disabled={busy || pending}
        type="button"
        onClick={onNew}
      >
        New conversation
      </button>
    ) : null}
  </header>
);

export const ProductWorkspace = ({
  userId,
  userName,
  conversationId,
  onConversation,
}: {
  userId: string;
  userName: string;
  conversationId?: string;
  onConversation: (conversationId?: string) => void;
}) => {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [conversationReference, setConversationReference] =
    useState<ConversationReference | null>(null);
  const selectionRevision = useRef(0);
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [tab, setTab] = useState<Tab>("conversation");
  const [creating, setCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [slackCode, setSlackCode] = useState<{
    code: string;
    expiresAt: string;
  } | null>(null);
  const setupIntent = useRef<OperationIntent | null>(null);
  const conversationIntent = useRef<OperationIntent | null>(null);
  useEffect(() => {
    const clear = () => {
      setAgents([]);
      setAgent(null);
      setConversationReference(null);
      selectionRevision.current += 1;
      setSelectedId("");
      setBudget(null);
      setSlackCode(null);
      setCreating(false);
    };
    window.addEventListener("cerebro:access-cleared", clear);
    return () => window.removeEventListener("cerebro:access-cleared", clear);
  }, []);
  const loadAgents = useCallback(async () => {
    const generation = currentAccessGeneration();
    const [list, amount] = await Promise.all([
      request(productPath("agents"), agentListSchema),
      readBudget(),
    ]);
    assertCurrentAccess(generation);
    setAgents(list.agents);
    setBudget(amount);
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
        { operationId: operationFor(setupIntent, { userId }) },
        setupSchema
      );
      setSetup(value);
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
      setTab("conversation");
      setCreating(false);
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
    setBusy(false);
  };
  const beginSlackLink = async () => {
    const generation = currentAccessGeneration();
    if (!setup) {
      return;
    }
    setBusy(true);
    setErrorMessage("");
    try {
      const value = slackLinkSchema.parse(
        await client.identity.beginSlackLink({
          organizationId: setup.organizationId,
        })
      );
      assertCurrentAccess(generation);
      setSlackCode(value);
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
  return (
    <main className="product-workspace">
      <aside className="product-sidebar">
        <a className="product-brand" href="/dashboard">
          <span className="brand-symbol">c</span>
          <span>
            cerebro<small>Company assistant</small>
          </span>
        </a>
        <div className="sidebar-section">
          <p className="eyebrow">Workspace</p>
          <div className="workspace-name">
            {userName || "Your company"}
            <span className="status-pill">{setup?.mode ?? "loading"}</span>
          </div>
        </div>
        <div className="sidebar-section agent-list-heading">
          <p className="eyebrow">Agents</p>
          {setup?.owner ? (
            <button
              className="icon-button"
              aria-label="Create an agent"
              type="button"
              onClick={() => {
                setCreating(true);
                setTab("configuration");
              }}
            >
              +
            </button>
          ) : null}
        </div>
        <nav className="agent-list" aria-label="Agents">
          {agents.map((entry) => (
            <button
              className={`agent-list-item ${entry.agentId === activeAgentId ? "selected" : ""}`}
              key={entry.agentId}
              type="button"
              onClick={() => {
                selectionRevision.current += 1;
                setConversationReference(null);
                onConversation();
                setSelectedId(entry.agentId);
                setCreating(false);
                setTab("configuration");
              }}
            >
              <span className="agent-avatar">
                {entry.name.slice(0, 1).toUpperCase()}
              </span>
              <span>
                {entry.name}
                <small>Version {entry.version}</small>
              </span>
            </button>
          ))}
        </nav>
        {agents.length === 0 && setup?.principalId ? (
          <p className="sidebar-empty">
            Create your first agent to start a conversation.
          </p>
        ) : null}
        <div className="sidebar-footer">
          <p className="eyebrow">Company budget</p>
          <strong>
            {budget
              ? `${budget.remaining.units.toLocaleString()} ${budget.remaining.unit}`
              : "No budget access"}
          </strong>
          <p>
            {budget?.mode === "fixture"
              ? "Local fixture balance"
              : "Shared across conversations"}
          </p>
          <button
            className="text-button"
            type="button"
            disabled={!setup?.principalId || busy}
            onClick={() => beginSlackLink()}
          >
            Link your Slack account
          </button>
          {slackCode ? (
            <div className="slack-link-code">
              <p>
                Send this complete command to the configured Slack bot in a
                direct message.
              </p>
              <code>link {slackCode.code}</code>
              <p>
                Expires {new Date(slackCode.expiresAt).toLocaleTimeString()}
              </p>
              <button
                className="text-button"
                type="button"
                onClick={() => setSlackCode(null)}
              >
                Hide code
              </button>
            </div>
          ) : null}
        </div>
      </aside>
      <div className="product-main">
        <WorkspaceHeader
          selected={selected}
          creating={creating}
          busy={busy}
          pending={conversationPending}
          onNew={startConversation}
        />
        {errorMessage ? (
          <p className="error-banner" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <WorkspaceBody
          setup={setup}
          selected={selected}
          agent={activeAgent}
          creating={creating}
          tab={tab}
          busy={busy}
          conversationId={conversationId}
          conversationPending={conversationPending}
          userId={userId}
          setTab={setTab}
          setCreating={setCreating}
          claimSetup={claimSetup}
          startConversation={startConversation}
          refreshAgent={refreshAgent}
          onSaved={async (agentId) => {
            const generation = currentAccessGeneration();
            await loadAgents();
            assertCurrentAccess(generation);
            setSelectedId(agentId);
            setCreating(false);
            const value = await request(
              productPath(`agents/${encoded(agentId)}`),
              agentDetailSchema
            );
            assertCurrentAccess(generation);
            setAgent(value);
          }}
        />
      </div>
    </main>
  );
};
