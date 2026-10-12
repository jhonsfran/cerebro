import {
  ChatDecisionReceipt,
  ChatReceipt,
  ChatSnapshot,
} from "@cerebro/contracts/session-service";
import { Schema } from "effect";
import { z } from "zod";

export const catalogSchema = z.object({
  connectorChoices: z.array(
    z.object({
      connectorId: z.string().optional(),
      id: z.string(),
      label: z.string(),
    })
  ),
  modelChoices: z.array(z.object({ id: z.string(), label: z.string() })),
  sourceChoices: z
    .array(z.object({ id: z.string(), label: z.string() }))
    .default([]),
});
export const setupSchema = z.object({
  bootstrapTokenRequired: z.boolean().default(false),
  canAdminister: z.boolean().default(false),
  mode: z.enum(["local", "production"]),
  organizationId: z.string(),
  owner: z.boolean(),
  principalId: z.string().nullable(),
  setupRequired: z.boolean(),
});
const actionSchema = z.enum(["read", "execute", "approve"]);
export const agentSummarySchema = z.object({
  agentId: z.string(),
  canManage: z.boolean(),
  model: z.string(),
  name: z.string(),
  version: z.number(),
});
export const agentListSchema = z.object({
  agents: z.array(agentSummarySchema),
});
const grantSchema = z.object({
  action: z.enum(["read", "execute", "write", "approve", "manage", "export"]),
  resource: z.object({
    id: z.string(),
    kind: z.enum(["agent", "tool", "memory", "artifact", "audit"]),
    organizationId: z.string(),
  }),
});
export const agentDetailSchema = z.object({
  access: z.array(
    z.object({
      actions: z.array(actionSchema),
      name: z.string(),
      principalId: z.string(),
    })
  ),
  agentId: z.string(),
  connectorChoices: z.array(
    z.object({
      connectorId: z.string().optional(),
      id: z.string(),
      label: z.string(),
    })
  ),
  definition: z.object({
    agentId: z.string(),
    enabledToolIds: z.array(z.string()),
    grants: z.array(grantSchema),
    instructions: z.string(),
    model: z.string(),
    organizationId: z.string(),
    version: z.number(),
  }),
  modelChoices: z.array(z.object({ id: z.string(), label: z.string() })),
  name: z.string(),
  sourceChoices: z
    .array(z.object({ id: z.string(), label: z.string() }))
    .default([]),
});
const chatSnapshotSchema = z
  .unknown()
  .transform((input) => Schema.decodeUnknownSync(ChatSnapshot)(input));
export const conversationSchema = z.object({
  agentId: z.string(),
  conversationId: z.string(),
  mode: z.string(),
  sessionId: z.string(),
  snapshot: chatSnapshotSchema,
});
export const savedAgentSchema = z.object({
  agentId: z.string(),
  version: z.number(),
});
export const createdConversationSchema = z.object({
  conversationId: z.string(),
});
export const messageReceiptSchema = z.object({
  receipt: z
    .unknown()
    .transform((input) => Schema.decodeUnknownSync(ChatReceipt)(input)),
});
export const stopReceiptSchema = z.object({ stopped: z.boolean() });
export const approvalReceiptSchema = z.object({
  approval: z
    .unknown()
    .transform((input) => Schema.decodeUnknownSync(ChatDecisionReceipt)(input)),
});
export const slackLinkSchema = z.object({
  code: z.string(),
  expiresAt: z.string(),
});
export const accessMutationSchema = z.unknown();
export type AccessAction = z.infer<typeof actionSchema>;
export type Setup = z.infer<typeof setupSchema>;
export type AgentSummary = z.infer<typeof agentSummarySchema>;
export type Grant = z.infer<typeof grantSchema>;
export type AgentDetail = z.infer<typeof agentDetailSchema>;
export type Conversation = z.infer<typeof conversationSchema>;

export const conversationReferenceSchema = conversationSchema.pick({
  agentId: true,
  conversationId: true,
});
export type ConversationReference = z.infer<typeof conversationReferenceSchema>;

export const connectorListSchema = z.object({
  connectors: z.array(
    z.object({
      id: z.string(),
      source: z.enum(["admin", "runtime.json"]),
      toolCount: z.number(),
      url: z.string().nullable(),
    })
  ),
});
export type ConnectorView = z.infer<
  typeof connectorListSchema
>["connectors"][number];
export const connectorChangeSchema = z.object({
  id: z.string(),
  skipped: z.array(z.string()),
  toolCount: z.number(),
});
export const connectorRemovedSchema = z.object({
  id: z.string(),
  removed: z.literal(true),
});

export const skillListSchema = z.object({
  skills: z.array(
    z.object({ body: z.string(), description: z.string(), name: z.string() })
  ),
});
export type SkillView = z.infer<typeof skillListSchema>["skills"][number];
export const skillSavedSchema = z.object({
  name: z.string(),
  saved: z.literal(true),
});
export const skillRemovedSchema = z.object({
  name: z.string(),
  removed: z.literal(true),
});
