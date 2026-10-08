import type {
  AgentDefinition,
  ContentDependencies,
  EventEnvelope,
  RunState,
  SessionReceipt,
} from "@cerebro/contracts";
import type {
  ApprovalState,
  SubmissionMode,
  ToolState,
} from "@cerebro/contracts/session-service";
import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export type ChannelItemBody = {
  readonly dependencies?: ContentDependencies;
} & (
  | {
      readonly type: "user";
      readonly eventId: string;
      readonly runId: string;
      readonly text: string;
      readonly mode?: SubmissionMode;
    }
  | {
      readonly type: "output";
      readonly runId: string;
      readonly text: string;
      readonly answerId?: string;
      readonly executionId?: string;
      readonly runIds?: readonly string[];
    }
  | {
      readonly type: "citation";
      readonly runId: string;
      readonly sourceId: string;
      readonly sourceVersion: string;
      readonly title: string;
      readonly href: string;
    }
  | {
      readonly type: "tool";
      readonly runId: string;
      readonly toolId: string;
      readonly operationId?: string;
      readonly output?: unknown;
      readonly arguments?: unknown;
      readonly name: string;
      readonly state: ToolState["state"];
    }
  | {
      readonly type: "approval";
      readonly runId: string;
      readonly approvalId: string;
      readonly operationId?: string;
      readonly state?: ApprovalState["state"];
      readonly expiresAt?: number;
    }
  | { readonly type: "run"; readonly runId: string; readonly run: RunState }
);

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
  activityVersion: integer("activity_version").notNull().default(0),
  agentId: text("agent_id").notNull(),
  bindingKey: text("binding_key").notNull().unique(),
  channelId: text("channel_id"),
  conversationId: text("conversation_id").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  engine: text("engine", { enum: ["legacy-v1", "pi-v1"] })
    .notNull()
    .default("legacy-v1"),
  kind: text("kind", { enum: ["web", "slack"] }).notNull(),
  lastProjectedAt: timestamp("last_projected_at").defaultNow().notNull(),
  organizationId: text("organization_id").notNull(),
  ownerPrincipalId: text("owner_principal_id").notNull(),
  projectionState: text("projection_state", { enum: ["active", "idle"] })
    .notNull()
    .default("idle"),
  retiredAt: timestamp("retired_at"),
  rootTimestamp: text("root_timestamp"),
  sessionId: text("session_id").notNull(),
  slackUserId: text("slack_user_id"),
  streamCursor: text("stream_cursor"),
  workspaceId: text("workspace_id"),
});
export const channelInbox = pgTable("channel_inbox", {
  conversationId: text("conversation_id").notNull(),
  digest: text("digest").notNull(),
  envelope: jsonb("envelope").$type<EventEnvelope>().notNull(),
  eventKey: text("event_key").primaryKey(),
  lastAttemptAt: timestamp("last_attempt_at").defaultNow().notNull(),
  organizationId: text("organization_id").notNull(),
  receipt: jsonb("receipt").$type<SessionReceipt>(),
  state: text("state", {
    enum: ["pending", "accepted", "denied", "quarantined"],
  }).notNull(),
  submissionMode: text("submission_mode", {
    enum: ["follow-up", "steer", "replace"],
  })
    .notNull()
    .default("follow-up"),
});
export const channelItem = pgTable("channel_item", {
  conversationId: text("conversation_id").notNull(),
  cursor: serial("cursor").primaryKey(),
  item: jsonb("item").$type<ChannelItemBody>().notNull(),
  itemKey: text("item_key").notNull().unique(),
  organizationId: text("organization_id").notNull(),
});
export const channelFixtureRun = pgTable("channel_fixture_run", {
  agentVersion: integer("agent_version").notNull(),
  conversationId: text("conversation_id").notNull(),
  digest: text("digest").notNull(),
  envelope: jsonb("envelope").$type<EventEnvelope>().notNull(),
  eventId: text("event_id").notNull().unique(),
  operationId: text("operation_id").notNull().unique(),
  organizationId: text("organization_id").notNull(),
  runId: text("run_id").primaryKey(),
  state: jsonb("state").$type<RunState>().notNull(),
});
export const channelEffect = pgTable("channel_effect", {
  digest: text("digest").notNull(),
  operationId: text("operation_id").primaryKey(),
  result: jsonb("result").$type<RunState | AccessChangeReceipt>().notNull(),
});
export const channelReply = pgTable("channel_reply", {
  attemptId: text("attempt_id"),
  conversationId: text("conversation_id").notNull(),
  organizationId: text("organization_id").notNull(),
  providerReceipt: jsonb("provider_receipt").$type<Record<string, unknown>>(),
  replyId: text("reply_id").primaryKey(),
  runId: text("run_id").notNull().unique(),
  startedAt: timestamp("started_at"),
  state: text("state", {
    enum: [
      "ready",
      "sending",
      "sent",
      "unknown-outcome",
      "failed",
      "quarantined",
    ],
  }).notNull(),
  text: text("text").notNull(),
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
  channelFixtureRun,
  channelInbox,
  channelItem,
  channelLinkEvent,
  channelReply,
  installationSetup,
};
