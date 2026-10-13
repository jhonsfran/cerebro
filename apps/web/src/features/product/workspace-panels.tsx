import { AccessPanel } from "./access-panel";
import { AgentEditor } from "./agent-editor";
import { ConversationPanel } from "./conversation";
import type { AgentDetail, AgentSummary, Setup } from "./types";
import type { AgentTab, WorkspaceView } from "./workspace-view";

interface WorkspaceBodyProps {
  setup: Setup | null;
  selected: AgentSummary | undefined;
  agent: AgentDetail | null;
  view: Exclude<WorkspaceView, { kind: "admin" }>;
  busy: boolean;
  conversationId: string | undefined;
  conversationPending: boolean;
  userId: string;
  setView: (view: WorkspaceView) => void;
  claimSetup: () => Promise<void>;
  bootstrapToken: string;
  setBootstrapToken: (token: string) => void;
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
  </section>
);
const InstallationSetup = ({
  setup,
  busy,
  bootstrapToken,
  setBootstrapToken,
  claimSetup,
}: Pick<
  WorkspaceBodyProps,
  "busy" | "bootstrapToken" | "setBootstrapToken" | "claimSetup"
> & { setup: Setup }) => (
  <section className="welcome-panel">
    <p className="eyebrow">Installation setup</p>
    <h2>Set up your company assistant.</h2>
    <p>
      The first owner configures agents and company access. The database permits
      one owner claim.
    </p>
    {setup.bootstrapTokenRequired ? (
      <label>
        Installation token
        <input
          type="password"
          autoComplete="off"
          value={bootstrapToken}
          onChange={(event) => setBootstrapToken(event.target.value)}
        />
      </label>
    ) : null}
    <button
      className="primary-button"
      disabled={busy || (setup.bootstrapTokenRequired && !bootstrapToken)}
      type="button"
      onClick={claimSetup}
    >
      {busy ? "Setting up..." : "Set up workspace"}
    </button>
  </section>
);
const AgentWorkspace = (props: WorkspaceBodyProps & { setup: Setup }) => {
  const {
    setup,
    selected,
    agent,
    view,
    busy,
    conversationId,
    conversationPending,
    userId,
    setView,
    startConversation,
    refreshAgent,
    onSaved,
  } = props;
  const tab: AgentTab = view.kind === "create" ? "configuration" : view.tab;
  let content = (
    <WelcomePanel
      setup={setup}
      selected={selected}
      busy={busy}
      startConversation={startConversation}
      create={() => {
        setView({ kind: "create" });
      }}
    />
  );
  if (view.kind === "create") {
    content = (
      <AgentEditor
        key="new"
        agent={null}
        setup={setup}
        onSaved={onSaved}
        onCancel={() => {
          setView({ kind: "agent", tab: "conversation" });
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
          onCancel={() => setView({ kind: "agent", tab: "conversation" })}
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
        onStartConversation={() => {
          void startConversation();
        }}
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
              setView(
                value === "configuration" && view.kind === "create"
                  ? view
                  : { kind: "agent", tab: value }
              );
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

export const WorkspaceBody = (props: WorkspaceBodyProps) => {
  const { setup, busy, bootstrapToken, setBootstrapToken, claimSetup } = props;
  if (!setup) {
    return (
      <section className="welcome-panel">
        <h2>Loading your workspace...</h2>
      </section>
    );
  }
  if (setup.setupRequired) {
    return (
      <InstallationSetup
        setup={setup}
        busy={busy}
        bootstrapToken={bootstrapToken}
        setBootstrapToken={setBootstrapToken}
        claimSetup={claimSetup}
      />
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
  return <AgentWorkspace {...props} setup={setup} />;
};

export const WorkspaceHeader = ({
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
