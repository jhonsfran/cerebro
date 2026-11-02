import { Avatar, AvatarFallback } from "@cerebro/ui/components/avatar";
import { Badge } from "@cerebro/ui/components/badge";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@cerebro/ui/components/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@cerebro/ui/components/tooltip";
import { Plus } from "lucide-react";

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
}) => {
  // On phones the sidebar is a sheet; choosing a destination closes it.
  const { setOpenMobile } = useSidebar();
  const go = (navigate: () => void) => {
    navigate();
    setOpenMobile(false);
  };
  return (
    <Sidebar className="top-(--header-height) h-[calc(100svh-var(--header-height))]">
      <SidebarContent>
        <nav aria-label="Workspace" className="flex flex-col">
          <SidebarGroup>
            <SidebarGroupLabel id="sidebar-agents-label">
              Agents
            </SidebarGroupLabel>
            {setup?.owner ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SidebarGroupAction
                      aria-label="Create an agent"
                      type="button"
                      onClick={() => go(() => setView({ kind: "create" }))}
                    />
                  }
                >
                  <Plus aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent side="right">Create an agent</TooltipContent>
              </Tooltip>
            ) : null}
            <SidebarGroupContent>
              {agents.length > 0 ? (
                <SidebarMenu aria-labelledby="sidebar-agents-label">
                  {agents.map((entry) => {
                    const active =
                      entry.agentId === activeAgentId && view.kind === "agent";
                    return (
                      <SidebarMenuItem key={entry.agentId}>
                        <SidebarMenuButton
                          size="lg"
                          type="button"
                          isActive={active}
                          aria-current={active ? "page" : undefined}
                          onClick={() => go(() => onSelect(entry.agentId))}
                        >
                          <Avatar aria-hidden="true">
                            <AvatarFallback>
                              {entry.name.slice(0, 1).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="truncate">{entry.name}</span>
                            <span className="text-muted-foreground truncate font-normal">
                              Version {entry.version}
                            </span>
                          </span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              ) : null}
              {agents.length === 0 && setup?.principalId ? (
                <p className="text-muted-foreground px-2 py-1 text-xs/relaxed">
                  Create your first agent to start a conversation.
                </p>
              ) : null}
            </SidebarGroupContent>
          </SidebarGroup>
          <AdminNav
            visible={setup?.canAdminister === true}
            active={view.kind === "admin" ? view.view : null}
            open={(admin) => go(() => setView({ kind: "admin", view: admin }))}
          />
        </nav>
      </SidebarContent>
      <SidebarFooter className="border-sidebar-border border-t">
        <div className="flex items-center justify-between gap-2 px-2 text-xs">
          <span className="truncate font-medium">
            {userName || "Your company"}
          </span>
          <Badge variant="outline">{setup?.mode ?? "loading"}</Badge>
        </div>
        <SlackLinkPanel setup={setup} />
      </SidebarFooter>
    </Sidebar>
  );
};
