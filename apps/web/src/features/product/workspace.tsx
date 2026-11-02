import { SidebarInset, SidebarProvider } from "@cerebro/ui/components/sidebar";

import { AdminPanel } from "./admin";
import type { AdminView } from "./admin";
import { ErrorAlert } from "./feedback";
import { useWorkspace } from "./use-workspace";
import { WorkspaceBody, WorkspaceHeader } from "./workspace-panels";
import { WorkspaceSidebar } from "./workspace-sidebar";

const adminTitles = {
  connectors: "Connectors",
  skills: "Skills",
} satisfies Record<AdminView, string>;

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
    <SidebarProvider className="h-full min-h-0">
      <WorkspaceSidebar
        userName={userName}
        setup={setup}
        agents={agents}
        activeAgentId={activeAgentId}
        view={view}
        setView={setView}
        onSelect={selectAgent}
      />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <WorkspaceHeader
          title={view.kind === "admin" ? adminTitles[view.view] : undefined}
          selected={view.kind === "admin" ? undefined : selected}
          creating={view.kind === "create"}
          offerNew={
            !(
              view.kind === "agent" &&
              view.tab === "conversation" &&
              !conversationId
            )
          }
          busy={busy}
          pending={conversationPending && !errorMessage}
          onNew={startConversation}
        />
        {errorMessage ? (
          <ErrorAlert className="mx-4 mt-4 w-auto">{errorMessage}</ErrorAlert>
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
            onConversation={onConversation}
          />
        )}
      </SidebarInset>
    </SidebarProvider>
  );
};
