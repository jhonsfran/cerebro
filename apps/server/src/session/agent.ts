import { agentAuthorityLayer } from "@cerebro/authorization/agent-authority";
import { AuthorityService } from "@cerebro/contracts/authority-service";
import type { EventAddress } from "@cerebro/contracts/events";
import {
  Denied,
  InvalidInput,
  Unavailable,
  fromPortResult,
  tryAdapter,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { ReadOptions } from "@cerebro/contracts/port";
import type {
  AgentDefinition,
  ContentDependencies,
} from "@cerebro/contracts/session";
import { withDatabase } from "@cerebro/db";
import { findSealedAccount } from "@cerebro/db/repositories/accounts";
import { createAgentRepository } from "@cerebro/db/repositories/agents";
import { listSkills } from "@cerebro/db/repositories/skills";
import { channelConversation } from "@cerebro/db/schema/agents";
import { SessionAgent as SessionHost } from "@cerebro/runtime/session-agent";
import type { SessionHostConfiguration } from "@cerebro/runtime/session-agent";
import { connectorAccountId, openCredentials } from "@cerebro/tools/accounts";
import { createConnectorExecutor } from "@cerebro/tools/connector";
import { bindRegisteredTool } from "@cerebro/tools/registry";
import type { Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import {
  checkContentDependencies,
  createCurrentAuthority,
  createCurrentEntitlements,
} from "../access";
import type { WorkerEnv } from "../bindings";
import { catalogTools } from "../catalog";
import { slackSettings } from "../channels";
import { createCatalogRegistry, runtimeConfiguration } from "../config";
import {
  SessionContent,
  migrateLegacySessionMetadata,
  sessionContentLayer,
} from "./content";
import { authenticateSessionRequest } from "./proof";
import { createSlackNotifier } from "./slack";

const readOptions = (): ReadOptions => ({ deadlineAt: Date.now() + 10_000 });

export const resolveSessionAddress = (
  env: WorkerEnv,
  name: string | undefined
) =>
  tryAdapter(() =>
    withDatabase(env, async (database) => {
      const identity: unknown = JSON.parse(name ?? "null");
      if (
        !Array.isArray(identity) ||
        identity.length !== 3 ||
        !identity.every((value) => typeof value === "string")
      ) {
        throw new Error("Invalid session name");
      }
      const [organizationId, agentId, conversationId] = identity;
      if (
        typeof organizationId !== "string" ||
        typeof agentId !== "string" ||
        typeof conversationId !== "string"
      ) {
        throw new TypeError("Invalid session name");
      }
      const [row] = await database
        .select()
        .from(channelConversation)
        .where(
          and(
            eq(channelConversation.organizationId, organizationId),
            eq(channelConversation.agentId, agentId),
            eq(channelConversation.conversationId, conversationId)
          )
        );
      if (!row || row.engine !== "pi-v1" || row.retiredAt) {
        throw new Error("The session conversation is retired or unavailable");
      }
      const address: EventAddress = {
        agentId: id.agent(row.agentId),
        conversationId: id.conversation(row.conversationId),
        organizationId: id.organization(row.organizationId),
        sessionId: id.session(row.sessionId),
      };
      return { address, conversation: row };
    })
  );

export const createRuntimeComposition = (
  env: WorkerEnv,
  storage: DurableObjectStorage,
  address: EventAddress,
  conversation?: typeof channelConversation.$inferSelect
): Effect.Effect<SessionHostConfiguration, ContractFailure> =>
  Effect.gen(function* composeSession() {
    const config = runtimeConfiguration(env);
    const slack = slackSettings(env);
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS cerebro_session_metadata (id INTEGER PRIMARY KEY CHECK (id=1), agent_version INTEGER NOT NULL, owner_principal_id TEXT NOT NULL)"
    );
    const [persisted] = storage.sql
      .exec<{ agent_version: number; owner_principal_id: string }>(
        "SELECT agent_version, owner_principal_id FROM cerebro_session_metadata WHERE id=1"
      )
      .toArray();
    const legacyAgentVersion = persisted
      ? undefined
      : migrateLegacySessionMetadata(storage);
    const ownerPrincipalId =
      persisted?.owner_principal_id ?? conversation?.ownerPrincipalId;
    if (!ownerPrincipalId) {
      return yield* Effect.fail(
        new InvalidInput({ reason: "The conversation owner is unavailable." })
      );
    }
    const agent: AgentDefinition = yield* tryAdapter(() =>
      withDatabase(env, (database) =>
        createAgentRepository(database).get(
          address.organizationId,
          address.agentId,
          persisted?.agent_version ?? legacyAgentVersion ?? "latest",
          readOptions()
        )
      )
    ).pipe(Effect.flatMap(fromPortResult));
    storage.sql.exec(
      "INSERT OR IGNORE INTO cerebro_session_metadata VALUES (1, ?, ?)",
      agent.version,
      ownerPrincipalId
    );
    const ownerContext = () =>
      tryAdapter(() =>
        withDatabase(env, async (database) => {
          const { contextByPrincipal } =
            await import("@cerebro/channels/security");
          return await contextByPrincipal(
            database,
            address.organizationId,
            ownerPrincipalId
          );
        })
      );
    const modelConfig = config.models.find(
      (candidate) => candidate.id === agent.model
    );
    if (!modelConfig) {
      return yield* Effect.fail(
        new InvalidInput({ reason: "The pinned model is not configured." })
      );
    }
    const catalog = yield* tryAdapter(() =>
      withDatabase(env, (database) =>
        catalogTools(database, address.organizationId)
      )
    );
    const registry = createCatalogRegistry(catalog, config.mode);
    const companySkills = yield* tryAdapter(() =>
      withDatabase(env, (database) =>
        listSkills(database, address.organizationId)
      )
    );
    const registered = yield* Effect.forEach(registry.list(), (entry) =>
      bindRegisteredTool(entry)
    );
    const current = createCurrentAuthority(env);
    const currentAuthority = yield* AuthorityService.pipe(
      Effect.provide(
        agentAuthorityLayer({
          checkSession: (request, options) =>
            tryAdapter(() =>
              withDatabase(env, async (database) => {
                const [owned] = await database
                  .select()
                  .from(channelConversation)
                  .where(
                    and(
                      eq(
                        channelConversation.organizationId,
                        address.organizationId
                      ),
                      eq(
                        channelConversation.conversationId,
                        address.conversationId
                      ),
                      eq(channelConversation.sessionId, address.sessionId),
                      eq(channelConversation.agentId, address.agentId)
                    )
                  );
                if (
                  !owned ||
                  owned.engine !== "pi-v1" ||
                  owned.retiredAt ||
                  owned.ownerPrincipalId !== request.context.actor.id
                ) {
                  throw new Denied({
                    code: "unauthorized",
                    reason: "The principal does not own this session.",
                  });
                }
                if (options.deadlineAt <= Date.now()) {
                  throw new Error("The session check deadline expired");
                }
              })
            ).pipe(
              Effect.mapError((failure) =>
                failure instanceof Denied ||
                failure instanceof InvalidInput ||
                failure instanceof Unavailable
                  ? failure
                  : new Unavailable({
                      reason: "Session ownership is unavailable.",
                    })
              )
            ),
          current,
          enabledModels: config.models.map((value) => value.id),
          entitlements: createCurrentEntitlements(env),
          tools: registered,
        })
      )
    );
    const authority = currentAuthority;
    const content = yield* SessionContent.pipe(
      Effect.provide(sessionContentLayer(env, storage, address, agent)),
      Effect.provideService(AuthorityService, authority)
    );
    const dependencies = (
      context: ExecutionContext,
      requested: ContentDependencies,
      options: ReadOptions
    ) =>
      tryAdapter(() =>
        withDatabase(env, (database) =>
          checkContentDependencies(
            env,
            database,
            context,
            {
              sourceIds: [
                ...new Set([
                  ...requested.sourceIds,
                  ...content.dependencies().sourceIds,
                ]),
              ],
              toolIds: requested.toolIds,
            },
            options
          )
        )
      ).pipe(Effect.flatMap(fromPortResult));
    const executor = createConnectorExecutor({
      credentials: async (organizationId, connectorId) => {
        const scope = {
          accountId: connectorAccountId(connectorId),
          organizationId,
        };
        const sealed = await withDatabase(env, (database) =>
          findSealedAccount(database, scope.organizationId, scope.accountId)
        );
        return sealed
          ? await openCredentials(env.ACCOUNT_KEY, scope, sealed)
          : undefined;
      },
      registry,
    });
    const model: Model<"openai-completions"> = {
      api: "openai-completions",
      baseUrl: modelConfig.baseUrl,
      contextWindow: modelConfig.maxInputBytes,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id: modelConfig.model,
      input: ["text"],
      maxTokens: modelConfig.maxOutputTokens,
      name: modelConfig.id,
      provider: modelConfig.provider,
      reasoning: false,
    };
    const provider = createProvider({
      api: openAICompletionsApi(),
      auth: {
        apiKey: {
          name: modelConfig.provider,
          resolve: () =>
            Promise.resolve({ auth: { apiKey: modelConfig.apiKey } }),
        },
      },
      baseUrl: modelConfig.baseUrl,
      id: modelConfig.provider,
      models: [model],
    });
    return {
      address,
      agent,
      authenticate: (request) =>
        authenticateSessionRequest(request, config.gatewaySigningKey, address),
      authority,
      checkDependencies: dependencies,
      executor,
      ...(slack?.botToken && conversation?.kind === "slack"
        ? {
            notify: createSlackNotifier({
              address,
              agent,
              authority,
              checkContent: (context) =>
                Effect.runPromise(
                  dependencies(context, content.dependencies(), readOptions())
                ),
              conversation,
              env,
              slack,
              storage,
            }),
          }
        : {}),
      ownerContext,
      prepareInput: content.prepareInput,
      provider: {
        deadlineMs: modelConfig.deadlineMs,
        maxInputBytes: modelConfig.maxInputBytes,
        model,
        provider,
      },
      skills: companySkills,
      toolDependencies: (tool) =>
        Effect.succeed({ sourceIds: [], toolIds: [tool.id] }),
      tools: registry.list().map((entry, index) => ({
        definition:
          registered[index] ??
          (() => {
            throw new InvalidInput({
              reason: "Registered tool binding is unavailable.",
            });
          })(),
        description: entry.description,
        idempotent: entry.retryMode === "idempotent",
        parameters: entry.inputJsonSchema,
        prepare: (args: unknown) =>
          Effect.try({
            catch: () =>
              new InvalidInput({ reason: "Tool arguments are invalid." }),
            try: () => entry.prepareArguments(args),
          }),
        requiresApproval: entry.requiresApproval,
      })),
    };
  });

export class SessionAgent extends SessionHost<WorkerEnv> {
  protected override configure() {
    return Effect.flatMap(
      resolveSessionAddress(this.env, this.ctx.id.name),
      ({ address, conversation }) =>
        createRuntimeComposition(
          this.env,
          this.ctx.storage,
          address,
          conversation
        )
    );
  }
}
