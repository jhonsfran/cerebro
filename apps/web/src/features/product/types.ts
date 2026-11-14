import {
  ChatControlReceipt,
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
      description: z.string().optional(),
      id: z.string(),
      label: z.string(),
      requiresApproval: z.boolean().optional(),
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
  primaryConversationId: z.string().optional(),
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
export const agentDetailSchema = catalogSchema.extend({
  access: z.array(
    z.object({
      actions: z.array(actionSchema),
      email: z.string().nullable(),
      name: z.string(),
      principalId: z.string(),
    })
  ),
  agentId: z.string(),
  definition: z.object({
    agentId: z.string(),
    enabledToolIds: z.array(z.string()),
    grants: z.array(grantSchema),
    instructions: z.string(),
    model: z.string(),
    organizationId: z.string(),
    team: z
      .object({
        limits: z
          .object({
            maxTurns: z.number().optional(),
            maxWorkers: z.number().optional(),
            timeoutMs: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
    version: z.number(),
  }),
  name: z.string(),
});
const chatSnapshotSchema = z
  .unknown()
  .transform((input) => Schema.decodeUnknownSync(ChatSnapshot)(input));
export const conversationReferenceSchema = z.object({
  agentId: z.string(),
  conversationId: z.string(),
  sessionId: z.string(),
});
export const conversationSchema = conversationReferenceSchema
  .extend({
    mode: z.string(),
    snapshot: chatSnapshotSchema,
  })
  .refine(
    (value) =>
      value.agentId === value.snapshot.address.agentId &&
      value.conversationId === value.snapshot.address.conversationId &&
      value.sessionId === value.snapshot.address.sessionId,
    "The conversation does not belong to this agent."
  );
export const savedAgentSchema = z.object({
  agentId: z.string(),
  version: z.number(),
});
export const messageReceiptSchema = z.object({
  receipt: z
    .unknown()
    .transform((input) => Schema.decodeUnknownSync(ChatReceipt)(input)),
});
export const stopReceiptSchema = z.object({ stopped: z.boolean() });
export const chatControlReceiptSchema = z
  .unknown()
  .transform((input) => Schema.decodeUnknownSync(ChatControlReceipt)(input));
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
export type ToolChoice = z.infer<
  typeof catalogSchema
>["connectorChoices"][number];
export type AgentSummary = z.infer<typeof agentSummarySchema>;
export type Grant = z.infer<typeof grantSchema>;
export type AgentDetail = z.infer<typeof agentDetailSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export interface LoadedConversation {
  readonly userId: string;
  readonly principalId: string;
  readonly accessGeneration: number;
  readonly selectionRevision: number;
  readonly conversation: Conversation;
}

export type ConversationReference = z.infer<typeof conversationReferenceSchema>;

export const connectorListSchema = z.object({
  connectors: z.array(
    z.object({
      id: z.string(),
      source: z.enum(["admin", "runtime.json"]),
      toolCount: z.number(),
      tools: z.array(
        z.object({
          description: z.string().optional(),
          effect: z.enum(["read", "write"]),
          id: z.string().optional(),
          name: z.string(),
          requiresApproval: z.boolean().optional(),
        })
      ),
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
