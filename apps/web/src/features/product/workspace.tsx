import { AdminPanel } from "./admin";
import { useWorkspace } from "./use-workspace";
import { WorkspaceBody, WorkspaceHeader } from "./workspace-panels";
import { WorkspaceSidebar } from "./workspace-sidebar";

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
  const {
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
  } = useWorkspace({ userId, conversationId, onConversation });
  return (
    <main className="product-workspace">
      <WorkspaceSidebar
        userName={userName}
        setup={setup}
        agents={agents}
        activeAgentId={activeAgentId}
        view={view}
        setView={setView}
        onSelect={selectAgent}
      />
      <div className="product-main">
        <WorkspaceHeader
          selected={view.kind === "admin" ? undefined : selected}
          creating={view.kind === "create"}
          busy={busy}
          pending={conversationPending && !errorMessage}
          onNew={startConversation}
        />
        {errorMessage ? (
          <p className="error-banner" role="alert">
            {errorMessage}
          </p>
        ) : null}
        {view.kind === "admin" ? (
          <AdminPanel view={view.view} />
        ) : (
          <WorkspaceBody
            setup={setup}
            selected={selected}
            agent={activeAgent}
            view={view}
            busy={busy}
            conversationId={conversationId}
            conversationPending={conversationPending && !errorMessage}
            userId={userId}
            setView={setView}
            claimSetup={claimSetup}
            bootstrapToken={bootstrapToken}
            setBootstrapToken={setBootstrapToken}
            startConversation={startConversation}
            refreshAgent={refreshAgent}
            onSaved={agentSaved}
          />
        )}
      </div>
    </main>
  );
};
