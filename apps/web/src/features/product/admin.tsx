import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@cerebro/ui/components/sidebar";
import { BookOpenText, Plug } from "lucide-react";

import { ConnectorsPanel } from "./connectors";
import { SkillsPanel } from "./skills";

export type AdminView = "connectors" | "skills";

const items = [
  { icon: Plug, label: "Connectors", view: "connectors" },
  { icon: BookOpenText, label: "Skills", view: "skills" },
] as const;

// Installation settings, shown to people with the installation manage grant.
export const AdminNav = ({
  visible,
  active,
  open,
}: {
  visible: boolean;
  active: AdminView | null;
  open: (view: AdminView) => void;
}) =>
  visible ? (
    <SidebarGroup>
      <SidebarGroupLabel id="sidebar-admin-label">
        Administration
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu aria-labelledby="sidebar-admin-label">
          {items.map(({ icon: Icon, label, view }) => (
            <SidebarMenuItem key={view}>
              <SidebarMenuButton
                type="button"
                isActive={active === view}
                aria-current={active === view ? "page" : undefined}
                onClick={() => open(view)}
              >
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  ) : null;

export const AdminPanel = ({ view }: { view: AdminView }) =>
  view === "connectors" ? <ConnectorsPanel /> : <SkillsPanel />;
