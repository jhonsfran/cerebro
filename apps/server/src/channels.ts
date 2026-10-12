import { createAuth } from "@cerebro/auth";
import type { ExecutionContext } from "@cerebro/contracts";
import type { ChatClient } from "@cerebro/contracts/session-service";
import type { Database } from "@cerebro/db";
import { withDatabase } from "@cerebro/db";
import { accessView } from "@cerebro/memory/access";
import { z } from "zod";

import { memoryDependencies, readSource } from "./access";
import type { WorkerEnv } from "./bindings";
import { catalogTools } from "./catalog";
import { runtimeConfiguration } from "./config";
import { createSessionClient } from "./session/client";

const slackConfiguration = z
  .object({
    agentId: z.string().min(1),
    apiUrl: z.string().url().optional(),
    appId: z.string().min(1),
    botToken: z.string().min(1).optional(),
    signingSecret: z.string().min(16),
    workspaceId: z.string().min(1),
  })
  .strict();

export const slackSettings = (env: WorkerEnv) => {
  const slack = env.SLACK_CHANNEL_JSON
    ? slackConfiguration.parse(JSON.parse(env.SLACK_CHANNEL_JSON))
    : undefined;
  if (env.DEPLOY_MODE === "production" && slack?.apiUrl) {
    throw new Error("Production uses the public Slack API URL.");
  }
  return slack;
};

export const createChannelOptions = (env: WorkerEnv) => {
  const config = runtimeConfiguration(env);
  const slack = slackSettings(env);
  return {
    bootstrapToken: config.bootstrapToken,
    catalogFor: async (database: Database, context: ExecutionContext) => {
      const access = await accessView(
        memoryDependencies(env, database),
        { context, organizationId: context.actor.organizationId },
        { deadlineAt: Date.now() + 10_000 }
      );
      if (access.status !== "ok") {
        return access;
      }
      const tools = await catalogTools(database, context.actor.organizationId);
      return {
        status: "ok" as const,
        value: {
          connectorChoices: tools.map((tool) => ({
            connectorId: tool.connectorId,
            id: tool.id,
            label: tool.description,
          })),
          modelChoices: config.models.map((model) => ({
            id: model.id,
            label: model.id,
          })),
          sourceChoices: access.value.sources.map((source) => ({
            id: source.id,
            label: source.uri,
          })),
        },
      };
    },
    getUser: async (request: Request, database: Database) => {
      const session = await createAuth(env, database).api.getSession({
        headers: request.headers,
      });
      return session?.user ?? null;
    },
    mode: env.DEPLOY_MODE,
    observationResponse: (input: Parameters<ChatClient["observe"]>[0]) =>
      createSessionClient(env).observe(input),
    organizationId: env.CHANNEL_ORGANIZATION_ID ?? "local-company",
    readSource: (
      database: Database,
      context: ExecutionContext,
      input: { sourceId: string }
    ) => readSource(env, database, context, input.sourceId),
    sessions: () => createSessionClient(env),
    slack,
    trustedOwnerUserId: config.trustedOwnerUserId,
    withDatabase: <T>(run: (database: Database) => Promise<T>) =>
      withDatabase(env, run),
  };
};
