import type { ChannelService } from "@cerebro/channels/service";
import { ChannelError } from "@cerebro/channels/types";
import { id } from "@cerebro/contracts";
import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s/]+$/u);
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
          kind: z.enum([
            "agent",
            "tool",
            "memory",
            "artifact",
            "audit",
            "budget",
          ]),
          organizationId: identifier.transform(id.organization),
        }),
      })
    )
    .max(64)
    .default([]),
  instructions: z.string().min(1).max(32_000),
  model: identifier,
  name: z.string().trim().min(1).max(120),
  operationId: identifier,
});
export const parseInput = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ChannelError(
      422,
      "invalid-input",
      "The request fields are invalid."
    );
  }
  return parsed.data;
};
export const handleAgentRequest = (
  service: ChannelService,
  method: string,
  path: readonly string[],
  userId: string,
  body: unknown
): Promise<unknown> => {
  if (path[0] === "setup") {
    if (method === "GET") {
      return service.setup(userId);
    }
    if (method === "POST") {
      parseInput(z.object({ operationId: identifier }), body);
      return service.install(userId);
    }
  }
  if (path[0] === "budget" && method === "GET") {
    return service.budget(userId);
  }
  if (path[0] === "agents") {
    if (path.length === 1 && method === "GET") {
      return service.listAgents(userId);
    }
    if (path.length === 1 && method === "POST") {
      return service.publishAgent(userId, parseInput(agentInput, body));
    }
    const [, agentId] = path;
    if (!agentId) {
      return Promise.resolve();
    }
    if (path.length === 2 && method === "GET") {
      return service.getAgent(userId, agentId);
    }
    if (path.length === 2 && method === "PUT") {
      return service.publishAgent(
        userId,
        parseInput(agentInput, body),
        agentId
      );
    }
    if (
      path[2] === "access" &&
      path[3] &&
      path.length === 4 &&
      method === "PUT"
    ) {
      const input = parseInput(
        z.object({
          actions: z.array(z.enum(["read", "execute", "approve"])).max(3),
          operationId: identifier,
        }),
        body
      );
      return service.setAccess(
        userId,
        agentId,
        path[3],
        [...new Set(input.actions)],
        input.operationId
      );
    }
  }
  return Promise.resolve();
};
