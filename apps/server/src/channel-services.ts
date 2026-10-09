import type { ProductHandlerOptions } from "@cerebro/channels/types";
import type { ExecutionContext, ContentDependencies } from "@cerebro/contracts";
import type { Database } from "@cerebro/db";
import { accessView } from "@cerebro/memory/access";
import { Effect } from "effect";
import { z } from "zod";

import type { WorkerEnv } from "./env.server";
import {
  memoryDependencies,
  checkContentDependencies,
  readAudit,
  readSource,
  runtimeConfiguration,
} from "./runtime-services";
import { createAuth, withDatabase } from "./services";
import { createSessionClient } from "./session-transport";

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
  const config = runtimeConfiguration(env);
  const slack = env.SLACK_CHANNEL_JSON
    ? slackConfiguration.parse(JSON.parse(env.SLACK_CHANNEL_JSON))
    : undefined;
  if (env.DEPLOY_MODE === "production" && slack?.apiUrl) {
    throw new Error("Production uses the public Slack API URL.");
  }
  return {
    bootstrapToken: config.bootstrapToken,
    catalog: {
      connectorChoices: config.tools.map((tool) => ({
        connectorId: tool.connectorId,
        id: tool.id,
        label: tool.description,
      })),
      modelChoices: config.models.map((model) => ({
        id: model.id,
        label: model.id,
      })),
    },
    catalogFor: async (database: Database, context: ExecutionContext) => {
      const access = await accessView(
        memoryDependencies(env, database),
        { context, organizationId: context.actor.organizationId },
        { deadlineAt: Date.now() + 10_000 }
      );
      if (access.status !== "ok") {
        return access;
      }
      return {
        status: "ok" as const,
        value: {
          connectorChoices: config.tools.map((tool) => ({
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
    checkContentDependencies: (
      database: Database,
      context: ExecutionContext,
      dependencies: ContentDependencies
    ) =>
      checkContentDependencies(env, database, context, dependencies, {
        deadlineAt: Date.now() + 10_000,
      }),
    getUser: async (request: Request, database: Database) => {
      const session = await createAuth(env, database).api.getSession({
        headers: request.headers,
      });
      return session?.user ?? null;
    },
    mode: env.DEPLOY_MODE,
    observationResponse: (
      input: Parameters<
        NonNullable<ProductHandlerOptions["observationResponse"]>
      >[0]
    ) =>
      Effect.runPromise(
        createSessionClient(env).observationResponse(
          input.address,
          input.context,
          input.accessGeneration,
          { deadlineAt: Number.MAX_SAFE_INTEGER, signal: input.signal }
        )
      ),
    organizationId: env.CHANNEL_ORGANIZATION_ID ?? "local-company",
    readAudit: (
      database: Database,
      context: ExecutionContext,
      input: { sessionId: string; runId: string }
    ) => readAudit(env, database, context, input.sessionId, input.runId),
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
