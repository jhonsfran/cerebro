import { createChannelService } from "@cerebro/channels/service";
import { ChannelError } from "@cerebro/channels/types";
import { id } from "@cerebro/contracts";
import { failureToHttp, isContractFailure } from "@cerebro/contracts/failures";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { o } from "../index";

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s/]+$/u);
const operation = z.object({ operationId: identifier });
const agentInput = z.object({
  enabledToolIds: z.array(identifier).max(32).default([]),
  expectedVersion: z.number().int().positive().optional(),
  grants: z
    .array(
      z.object({
        action: z.enum([
          "read",
          "execute",
          "write",
          "approve",
          "manage",
          "export",
        ]),
        resource: z.object({
          id: identifier,
          kind: z.enum(["agent", "tool", "memory", "artifact", "audit"]),
          organizationId: identifier.transform(id.organization),
        }),
      })
    )
    .max(64)
    .default([]),
  instructions: z.string().min(1).max(32_000),
  model: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\s/]+(?:\/[^\s/]+)*$/u),
  name: z.string().trim().min(1).max(120),
  operationId: identifier,
});
const conversation = z.object({ conversationId: z.string().min(1) });
const connectorId = z.object({ connectorId: identifier });
// The Agent Skills name rule: lowercase words joined by single hyphens.
const skillName = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const connectorInput = z.object({
  headers: z
    .record(z.string().min(1).max(128), z.string().min(1).max(4096))
    .refine((value) => Object.keys(value).length <= 16)
    .default({}),
  id: identifier,
  url: z.string().min(1).max(2048),
});

const product = o
  .use(async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      if (error instanceof ChannelError) {
        throw new ORPCError(error.code, {
          message: error.message,
          status: error.status,
        });
      }
      if (isContractFailure(error)) {
        const response = failureToHttp(error);
        throw new ORPCError(error._tag, {
          message: response.body.message,
          status: response.status,
        });
      }
      if (error instanceof ORPCError && error.code === "BAD_REQUEST") {
        throw new ORPCError("invalid-input", {
          message: "The request fields are invalid.",
          status: 422,
        });
      }
      if (error instanceof ORPCError) {
        throw error;
      }
      throw new ORPCError("unavailable", {
        message: "The product service is unavailable.",
        status: 503,
      });
    }
  })
  .use(({ context, next }) => {
    const userId = context.session?.user.id;
    if (!userId) {
      throw new ChannelError(401, "unauthorized", "Sign in to continue.");
    }
    if (!context.channels) {
      throw new ChannelError(
        503,
        "unavailable",
        "The product service is unavailable."
      );
    }
    return next({
      context: {
        service: createChannelService(context.db, context.channels),
        userId,
      },
    });
  });

export const productRouter = {
  addConnector: product
    .route({ method: "POST", path: "/product/connectors" })
    .input(connectorInput)
    .handler(({ context, input }) =>
      context.service.addConnector(context.userId, input)
    ),
  approve: product
    .route({
      method: "POST",
      path: "/product/conversations/{conversationId}/approvals/{approvalId}",
    })
    .input(
      z.strictObject({
        approvalId: z.string().min(1),
        conversationId: z.string().min(1),
        decision: z.enum(["allow", "deny"]),
      })
    )
    .handler(({ context, input }) =>
      context.service.approve(
        context.userId,
        input.conversationId,
        input.approvalId,
        input.decision
      )
    ),
  catalog: product
    .route({ method: "GET", path: "/product/catalog" })
    .handler(({ context }) => context.service.catalog(context.userId)),
  createAgent: product
    .route({ method: "POST", path: "/product/agents" })
    .input(agentInput)
    .handler(({ context, input }) =>
      context.service.publishAgent(context.userId, input)
    ),
  createConversation: product
    .route({ method: "POST", path: "/product/conversations" })
    .input(
      z.object({
        agentId: z.string().min(1).max(256),
        operationId: z.string().min(1).max(256),
      })
    )
    .handler(({ context, input }) =>
      context.service.createConversation(
        context.userId,
        input.agentId,
        input.operationId
      )
    ),
  deleteSkill: product
    .route({ method: "DELETE", path: "/product/skills/{name}" })
    .input(z.object({ name: skillName }))
    .handler(({ context, input }) =>
      context.service.deleteSkill(context.userId, input.name)
    ),
  getAgent: product
    .route({ method: "GET", path: "/product/agents/{agentId}" })
    .input(z.object({ agentId: z.string().min(1) }))
    .handler(({ context, input }) =>
      context.service.getAgent(context.userId, input.agentId)
    ),
  getConversation: product
    .route({ method: "GET", path: "/product/conversations/{conversationId}" })
    .input(conversation)
    .handler(({ context, input }) =>
      context.service.readConversation(context.userId, input.conversationId)
    ),
  history: product
    .route({
      method: "GET",
      path: "/product/conversations/{conversationId}/history",
    })
    .input(conversation)
    .handler(({ context, input }) =>
      context.service.history(context.userId, input.conversationId)
    ),
  install: product
    .route({ method: "POST", path: "/product/setup" })
    .input(
      operation.extend({
        bootstrapToken: z.string().min(1).max(4096).optional(),
      })
    )
    .handler(({ context, input }) =>
      context.service.install(context.userId, input.bootstrapToken)
    ),
  listAgents: product
    .route({ method: "GET", path: "/product/agents" })
    .handler(({ context }) => context.service.listAgents(context.userId)),
  listConnectors: product
    .route({ method: "GET", path: "/product/connectors" })
    .handler(({ context }) => context.service.listConnectors(context.userId)),
  listConversations: product
    .route({ method: "GET", path: "/product/conversations" })
    .handler(({ context }) =>
      context.service.listConversations(context.userId)
    ),
  listSkills: product
    .route({ method: "GET", path: "/product/skills" })
    .handler(({ context }) => context.service.listSkills(context.userId)),
  putSkill: product
    .route({ method: "PUT", path: "/product/skills/{name}" })
    .input(
      z.object({
        body: z.string().trim().min(1).max(32_000),
        description: z.string().trim().min(1).max(1024),
        name: skillName,
      })
    )
    .handler(({ context, input }) =>
      context.service.putSkill(context.userId, input)
    ),
  refreshConnector: product
    .route({
      method: "POST",
      path: "/product/connectors/{connectorId}/refresh",
    })
    .input(connectorId)
    .handler(({ context, input }) =>
      context.service.refreshConnector(context.userId, input.connectorId)
    ),
  removeConnector: product
    .route({ method: "DELETE", path: "/product/connectors/{connectorId}" })
    .input(connectorId)
    .handler(({ context, input }) =>
      context.service.removeConnector(context.userId, input.connectorId)
    ),
  setAccess: product
    .route({
      method: "PUT",
      path: "/product/agents/{agentId}/access/{principalId}",
    })
    .input(
      operation.extend({
        actions: z.array(z.enum(["read", "execute", "approve"])).max(3),
        agentId: z.string().min(1),
        principalId: z.string().min(1),
      })
    )
    .handler(({ context, input }) =>
      context.service.setAccess(
        context.userId,
        input.agentId,
        input.principalId,
        [...new Set(input.actions)],
        input.operationId
      )
    ),
  setup: product
    .route({ method: "GET", path: "/product/setup" })
    .handler(({ context }) => context.service.setup(context.userId)),
  source: product
    .route({
      method: "GET",
      path: "/product/conversations/{conversationId}/sources/{sourceId}",
    })
    .input(conversation.extend({ sourceId: z.string().min(1) }))
    .handler(({ context, input }) =>
      context.service.source(
        context.userId,
        input.conversationId,
        input.sourceId
      )
    ),
  stop: product
    .route({
      method: "POST",
      path: "/product/conversations/{conversationId}/stop",
    })
    .input(
      z.strictObject({
        conversationId: z.string().min(1),
      })
    )
    .handler(({ context, input }) =>
      context.service.stop(context.userId, input.conversationId)
    ),
  submit: product
    .route({
      method: "POST",
      path: "/product/conversations/{conversationId}/messages",
    })
    .input(
      conversation.extend({
        operationId: z.string().min(1).max(256),
        text: z.string().trim().min(1).max(16_000),
      })
    )
    .handler(({ context, input }) =>
      context.service.submit(
        context.userId,
        input.conversationId,
        input.operationId,
        input.text
      )
    ),
  updateAgent: product
    .route({ method: "PUT", path: "/product/agents/{agentId}" })
    .input(agentInput.extend({ agentId: z.string().min(1) }))
    .handler(({ context, input }) => {
      const { agentId, ...definition } = input;
      return context.service.publishAgent(context.userId, definition, agentId);
    }),
};
