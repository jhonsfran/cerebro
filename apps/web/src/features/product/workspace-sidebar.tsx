import { AdminNav } from "./admin";
import { SlackLinkPanel } from "./slack-link";
import type { AgentSummary, Setup } from "./types";
import type { WorkspaceView } from "./workspace-view";

export const WorkspaceSidebar = ({
  userName,
  setup,
  agents,
  activeAgentId,
  view,
  setView,
  onSelect,
}: {
  userName: string;
  setup: Setup | null;
  agents: readonly AgentSummary[];
  activeAgentId: string;
  view: WorkspaceView;
  setView: (view: WorkspaceView) => void;
  onSelect: (agentId: string) => void;
}) => (
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
    <AdminNav
      visible={setup?.canAdminister === true}
      active={view.kind === "admin" ? view.view : null}
      open={(admin) => setView({ kind: "admin", view: admin })}
    />
    <div className="sidebar-section agent-list-heading">
      <p className="eyebrow">Agents</p>
      {setup?.owner ? (
        <button
          className="icon-button"
          aria-label="Create an agent"
          type="button"
          onClick={() => {
            setView({ kind: "create" });
          }}
        >
          +
        </button>
      ) : null}
    </div>
    <nav className="agent-list" aria-label="Agents">
      {agents.map((entry) => (
        <button
          className={`agent-list-item ${entry.agentId === activeAgentId && view.kind !== "admin" ? "selected" : ""}`}
          key={entry.agentId}
          type="button"
          onClick={() => onSelect(entry.agentId)}
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
    <SlackLinkPanel setup={setup} />
  </aside>
);
