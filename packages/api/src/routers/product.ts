import { createChannelService } from "@cerebro/channels/service";
import { ChannelError } from "@cerebro/channels/types";
import { id } from "@cerebro/contracts";
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

// Product calls keep their channel error codes and HTTP statuses, and invalid
// input stays a 422, so REST callers see the same responses as before.
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
  approve: product
    .route({
      method: "POST",
      path: "/product/conversations/{conversationId}/approvals/{approvalId}",
    })
    // An approval names exactly one decision; any extra field is refused.
    .input(
      z.strictObject({
        approvalId: z.string().min(1),
        conversationId: z.string().min(1),
        decision: z.enum(["allow", "deny"]),
        operationId: z.string().min(1).max(256),
        runId: z.string().min(1).max(256),
      })
    )
    .handler(({ context, input }) =>
      context.service.approve(
        context.userId,
        input.conversationId,
        input.approvalId,
        input.operationId,
        input.runId,
        input.decision
      )
    ),
  audit: product
    .route({
      method: "GET",
      path: "/product/conversations/{conversationId}/audit/{runId}",
    })
    .input(conversation.extend({ runId: z.string().min(1) }))
    .handler(({ context, input }) =>
      context.service.audit(context.userId, input.conversationId, input.runId)
    ),
  cancel: product
    .route({
      method: "POST",
      path: "/product/conversations/{conversationId}/runs/{runId}/cancel",
    })
    .input(
      z.strictObject({
        conversationId: z.string().min(1),
        operationId: z.string().min(1).max(256),
        runId: z.string().min(1),
      })
    )
    .handler(({ context, input }) =>
      context.service.cancel(
        context.userId,
        input.conversationId,
        input.runId,
        input.operationId
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
  getAgent: product
    .route({ method: "GET", path: "/product/agents/{agentId}" })
    .input(z.object({ agentId: z.string().min(1) }))
    .handler(({ context, input }) =>
      context.service.getAgent(context.userId, input.agentId)
    ),
  getConversation: product
    .route({ method: "GET", path: "/product/conversations/{conversationId}" })
    .input(conversation.extend({ cursor: z.string().optional() }))
    .handler(({ context, input }) =>
      context.service.readConversation(
        context.userId,
        input.conversationId,
        input.cursor
      )
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
  listConversations: product
    .route({ method: "GET", path: "/product/conversations" })
    .handler(({ context }) =>
      context.service.listConversations(context.userId)
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
  submit: product
    .route({
      method: "POST",
      path: "/product/conversations/{conversationId}/messages",
    })
    .input(
      conversation.extend({
        eventId: z.string().min(1).max(256),
        mode: z.enum(["follow-up", "steer", "replace"]).default("follow-up"),
        text: z.string().trim().min(1).max(16_000),
      })
    )
    .handler(({ context, input }) =>
      context.service.submit(
        context.userId,
        input.conversationId,
        input.eventId,
        input.text,
        input.mode
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
