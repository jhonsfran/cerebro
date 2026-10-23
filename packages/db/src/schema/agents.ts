import type { AgentDefinition } from "@cerebro/contracts";
import type { ConversationForkOrigin } from "@cerebro/contracts/session-service";
import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export interface AccessChangeReceipt {
  readonly principalId: string;
  readonly actions: readonly ("read" | "execute" | "approve")[];
  readonly source: "manual";
}
export const installationSetup = pgTable("installation_setup", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  ownerPrincipalId: text("owner_principal_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
});
export const agent = pgTable(
  "agent",
  {
    agentId: text("agent_id").notNull(),
    currentVersion: integer("current_version").notNull(),
    name: text("name").notNull(),
    organizationId: text("organization_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.agentId] })]
);
export const agentVersion = pgTable(
  "agent_version",
  {
    agentId: text("agent_id").notNull(),
    definition: jsonb("definition").$type<AgentDefinition>().notNull(),
    organizationId: text("organization_id").notNull(),
    version: integer("version").notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.agentId, t.version] })]
);
export const agentPublishOperation = pgTable(
  "agent_publish_operation",
  {
    definition: jsonb("definition").$type<AgentDefinition>().notNull(),
    digest: text("digest").notNull(),
    operationId: text("operation_id").notNull(),
    organizationId: text("organization_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.operationId] })]
);
export const channelConversation = pgTable("channel_conversation", {
  agentId: text("agent_id").notNull(),
  bindingKey: text("binding_key").notNull().unique(),
  channelId: text("channel_id"),
  conversationId: text("conversation_id").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  engine: text("engine", { enum: ["legacy-v1", "pi-v1", "pi-identity-v1"] })
    .notNull()
    .default("legacy-v1"),
  kind: text("kind", { enum: ["web", "slack"] }).notNull(),
  forkOrigin: jsonb("fork_origin").$type<ConversationForkOrigin>(),
  organizationId: text("organization_id").notNull(),
  ownerPrincipalId: text("owner_principal_id").notNull(),
  retiredAt: timestamp("retired_at"),
  rootTimestamp: text("root_timestamp"),
  sessionId: text("session_id").notNull(),
  slackUserId: text("slack_user_id"),
  workspaceId: text("workspace_id"),
});
export const channelEffect = pgTable("channel_effect", {
  digest: text("digest").notNull(),
  operationId: text("operation_id").primaryKey(),
  result: jsonb("result").$type<AccessChangeReceipt>().notNull(),
});
export const channelLinkEvent = pgTable("channel_link_event", {
  digest: text("digest").notNull(),
  eventKey: text("event_key").primaryKey(),
  principalId: text("principal_id").notNull(),
});
export const agentSchema = {
  agent,
  agentPublishOperation,
  agentVersion,
  channelConversation,
  channelEffect,
  channelLinkEvent,
  installationSetup,
};
