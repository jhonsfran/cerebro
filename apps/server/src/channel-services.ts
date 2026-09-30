import type { ExecutionContext, ContentDependencies } from "@cerebro/contracts";
import type { Database } from "@cerebro/db";
import { createAgentRepository } from "@cerebro/db/repositories/agents";
import { accessView } from "@cerebro/memory/access";
import { createSessionService } from "@cerebro/runtime";
import { z } from "zod";

import type { WorkerEnv } from "./env.server";
import {
  memoryDependencies,
  checkContentDependencies,
  createCurrentAuthorization,
  createCurrentBudget,
  createCurrentEntitlements,
  readAudit,
  readSource,
  runtimeConfiguration,
} from "./runtime-services";
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
  const config = runtimeConfiguration(env);
  const slack = env.SLACK_CHANNEL_JSON
    ? slackConfiguration.parse(JSON.parse(env.SLACK_CHANNEL_JSON))
    : undefined;
  if (env.DEPLOY_MODE !== "fixture" && slack?.apiUrl) {
    throw new Error(
      "A custom Slack API URL is permitted only in fixture mode."
    );
  }
  return {
    bootstrapToken: config.bootstrapToken,
    budget: createCurrentBudget(env),
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
    sessions: (database: Database) =>
      createSessionService({
        agentRepository: createAgentRepository(database),
        authorizationPolicy: createCurrentAuthorization(env),
        checkContentDependencies: (context, dependencies, options) =>
          withDatabase(env, (connection) =>
            checkContentDependencies(
              env,
              connection,
              context,
              dependencies,
              options
            )
          ),
        entitlementPolicy: createCurrentEntitlements(env),
        namespace: env.SESSION,
      }),
    slack,
    trustedOwnerUserId: config.trustedOwnerUserId,
    withDatabase: <T>(run: (database: Database) => Promise<T>) =>
      withDatabase(env, run),
  };
};
