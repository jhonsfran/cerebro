import type { AdminView } from "./admin";

export type AgentTab = "conversation" | "configuration" | "access";
export type WorkspaceView =
  | { readonly kind: "agent"; readonly tab: AgentTab }
  | { readonly kind: "create" }
  | { readonly kind: "admin"; readonly view: AdminView };
