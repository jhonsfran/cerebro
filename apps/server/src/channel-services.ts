import type { Database } from "@cerebro/db";
import { z } from "zod";

import type { WorkerEnv } from "./env.server";
import { createAuth, withDatabase } from "./services";

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

export const createChannelOptions = (env: WorkerEnv) => {
  const slack = env.SLACK_CHANNEL_JSON
    ? slackConfiguration.parse(JSON.parse(env.SLACK_CHANNEL_JSON))
    : undefined;
  if (env.DEPLOY_MODE === "production" && slack?.apiUrl) {
    throw new Error(
      "A custom Slack API URL is permitted only in fixture mode."
    );
  }
  return {
    getUser: async (request: Request, database: Database) => {
      const session = await createAuth(env, database).api.getSession({
        headers: request.headers,
      });
      return session?.user ?? null;
    },
    mode: env.DEPLOY_MODE,
    organizationId: env.CHANNEL_ORGANIZATION_ID ?? "local-company",
    slack,
    withDatabase: <T>(run: (database: Database) => Promise<T>) =>
      withDatabase(env, run),
  };
};
