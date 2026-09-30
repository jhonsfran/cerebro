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
  mode: z.enum(["local", "fixture", "production"]),
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
    kind: z.enum(["agent", "tool", "memory", "artifact", "audit", "budget"]),
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
const runSchema = z.object({
  runId: z.string(),
  state: z.enum([
    "queued",
    "running",
    "waiting-for-approval",
    "completed",
    "failed",
    "cancelled",
    "unknown-outcome",
  ]),
});
export const conversationItemSchema = z.discriminatedUnion("type", [
  z.object({
    cursor: z.string(),
    eventId: z.string().optional(),
    text: z.string(),
    type: z.literal("user"),
  }),
  z.object({
    cursor: z.string(),
    runId: z.string(),
    text: z.string(),
    type: z.literal("output"),
  }),
  z.object({
    cursor: z.string(),
    href: z.string(),
    runId: z.string(),
    sourceId: z.string(),
    sourceVersion: z.union([z.string(), z.number()]).transform(String),
    title: z.string(),
    type: z.literal("citation"),
  }),
  z.object({
    cursor: z.string(),
    name: z.string(),
    runId: z.string(),
    state: z.string(),
    toolId: z.string(),
    type: z.literal("tool"),
  }),
  z.object({
    approvalId: z.string(),
    cursor: z.string(),
    runId: z.string(),
    type: z.literal("approval"),
  }),
  z.object({ cursor: z.string(), run: runSchema, type: z.literal("run") }),
]);
export const conversationSchema = z.object({
  agentId: z.string(),
  conversationId: z.string(),
  cursor: z.string(),
  items: z.array(conversationItemSchema),
  mode: z.string(),
  sessionId: z.string(),
  snapshot: z.object({ runs: z.array(runSchema) }),
});
export const pendingSchema = z.object({
  eventId: z.string(),
  text: z.string(),
});
export const historySchema = z.object({
  projectionStatus: z.string(),
  runs: z.array(
    z.object({ auditHref: z.string(), runId: z.string(), state: z.string() })
  ),
});
export const sourceSchema = z.object({
  mode: z.string(),
  sourceId: z.string(),
  sourceVersion: z.union([z.string(), z.number()]).transform(String),
  text: z.string(),
  title: z.string(),
});
export const auditSchema = z.object({
  entries: z.array(
    z.object({
      at: z.union([z.number(), z.string()]),
      description: z.string(),
      type: z.string(),
    })
  ),
  mode: z.string(),
  runId: z.string(),
  state: z.string(),
});
export const budgetSchema = z.object({
  mode: z.string(),
  remaining: z.object({ unit: z.string(), units: z.number() }),
});
export const savedAgentSchema = z.object({
  agentId: z.string(),
  version: z.number(),
});
export const createdConversationSchema = z.object({
  conversationId: z.string(),
});
export const messageReceiptSchema = z.object({
  cursor: z.string(),
  receipt: z.object({
    acceptedEventId: z.string(),
    replayed: z.boolean(),
    runId: z.string(),
    sessionId: z.string(),
  }),
});
export const stateMutationSchema = z.object({ run: runSchema });
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
export type ConversationItem = z.infer<typeof conversationItemSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type PendingMessage = z.infer<typeof pendingSchema>;
export type History = z.infer<typeof historySchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Audit = z.infer<typeof auditSchema>;
export type Budget = z.infer<typeof budgetSchema>;

export const conversationReferenceSchema = conversationSchema.pick({
  agentId: true,
  conversationId: true,
});
export type ConversationReference = z.infer<typeof conversationReferenceSchema>;
