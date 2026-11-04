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
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { ReadOptions } from "@cerebro/contracts/port";
import type {
  AgentDefinition,
  ContentDependencies,
} from "@cerebro/contracts/session";
import type { RegisteredTool } from "@cerebro/contracts/tool-service";
import { withDatabase } from "@cerebro/db";
import { findSealedAccount } from "@cerebro/db/repositories/accounts";
import { createAgentRepository } from "@cerebro/db/repositories/agents";
import { listSkills } from "@cerebro/db/repositories/skills";
import { channelConversation } from "@cerebro/db/schema/agents";
import { sendToAuditSink } from "@cerebro/runtime/audit-sink";
import type { MetadataTransaction } from "@cerebro/runtime/session-agent";
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
import { createCatalogRegistry, runtimeConfiguration } from "../config";
import { SessionContent, sessionContentLayer } from "./content";

export const createExecutionComposition = (
  env: WorkerEnv,
  storage: DurableObjectStorage,
  sourceAddress: EventAddress,
  address: EventAddress,
  agent: AgentDefinition,
  ownerPrincipalId: string,
  metadata: MetadataTransaction,
  readOnly = false
) =>
  Effect.gen(function* composeExecution() {
    const config = runtimeConfiguration(env);
    const ownerContext = () =>
      tryAdapter(() =>
        withDatabase(env, async (database) => {
          const { contextByPrincipal } =
            await import("@cerebro/channels/security");
          return await contextByPrincipal(
            database,
            sourceAddress.organizationId,
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
    const tools = yield* Effect.forEach(registry.list(), (entry) =>
      Effect.gen(function* bindTool() {
        const definition = yield* bindRegisteredTool(entry);
        return {
          definition,
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
        };
      })
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
                        sourceAddress.organizationId
                      ),
                      eq(
                        channelConversation.conversationId,
                        sourceAddress.conversationId
                      ),
                      eq(
                        channelConversation.sessionId,
                        sourceAddress.sessionId
                      ),
                      eq(channelConversation.agentId, sourceAddress.agentId)
                    )
                  );
                if (
                  request.address.agentId !== address.agentId ||
                  request.address.sessionId !== address.sessionId ||
                  request.address.conversationId !== address.conversationId ||
                  !owned ||
                  owned.engine !== "pi-identity-v1" ||
                  owned.retiredAt ||
                  owned.ownerPrincipalId !== ownerPrincipalId ||
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
          tools: tools.map((tool) => tool.definition),
        })
      )
    );
    const authority = currentAuthority;
    const content = yield* SessionContent.pipe(
      Effect.provide(
        sessionContentLayer(env, storage, address, agent, metadata, readOnly)
      ),
      Effect.provideService(AuthorityService, authority)
    );
    const dependencies = (
      context: ExecutionContext,
      requested: ContentDependencies,
      options: ReadOptions
    ) =>
      Effect.gen(function* checkDependencies() {
        if (sourceAddress.sessionId !== address.sessionId) {
          const sourceAgent = yield* tryAdapter(() =>
            withDatabase(env, (database) =>
              createAgentRepository(database).get(
                sourceAddress.organizationId,
                sourceAddress.agentId,
                "latest",
                options
              )
            )
          ).pipe(Effect.flatMap(fromPortResult));
          yield* Effect.all(
            (["read", "execute"] as const).map((action) =>
              current.require(
                {
                  action,
                  address: sourceAddress,
                  context,
                  pinnedAgent: sourceAgent,
                  resource: {
                    id: sourceAddress.agentId,
                    kind: "agent",
                    organizationId: sourceAddress.organizationId,
                  },
                },
                options
              )
            )
          );
        }
        const recorded = yield* tryAdapter(() => content.dependencies());
        const history = yield* tryAdapter(() => content.historyDependencies());
        for (const source of history) {
          const definition = yield* tryAdapter(() =>
            withDatabase(env, async (database) => {
              const [row] = await database
                .select()
                .from(channelConversation)
                .where(
                  and(
                    eq(
                      channelConversation.organizationId,
                      source.organizationId
                    ),
                    eq(channelConversation.agentId, source.agentId),
                    eq(
                      channelConversation.conversationId,
                      source.conversationId
                    ),
                    eq(channelConversation.sessionId, source.sessionId)
                  )
                );
              if (
                !row ||
                row.ownerPrincipalId !== ownerPrincipalId ||
                row.retiredAt ||
                row.engine !== "pi-identity-v1"
              ) {
                throw new Denied({
                  code: "revoked",
                  reason:
                    "A conversation used as evidence is no longer available.",
                });
              }
              return await createAgentRepository(database).get(
                source.organizationId,
                source.agentId,
                "latest",
                options
              );
            })
          ).pipe(Effect.flatMap(fromPortResult));
          yield* current.require(
            {
              action: "read",
              address: source,
              context,
              pinnedAgent: definition,
              resource: {
                id: source.agentId,
                kind: "agent",
                organizationId: source.organizationId,
              },
            },
            options
          );
        }
        const combined = {
          sourceIds: [
            ...new Set([...requested.sourceIds, ...recorded.sourceIds]),
          ],
          toolIds: [...new Set([...requested.toolIds, ...recorded.toolIds])],
        };
        if (readOnly) {
          yield* Effect.all(
            combined.sourceIds.map((sourceId) =>
              authority.require(
                {
                  action: "read",
                  address,
                  context,
                  pinnedAgent: agent,
                  resource: {
                    id: sourceId,
                    kind: "memory",
                    organizationId: address.organizationId,
                  },
                },
                options
              )
            )
          );
          yield* Effect.all(
            combined.toolIds.map((toolId) => {
              const registered = tools.find(
                (tool) => tool.definition.id === toolId
              );
              if (!registered) {
                return Effect.fail(
                  new Denied({
                    code: "revoked",
                    reason: "The receiving role cannot read this tool.",
                  })
                );
              }
              return authority.require(
                {
                  action: "read",
                  address,
                  context,
                  pinnedAgent: agent,
                  tool: registered.definition,
                  resource: {
                    id: toolId,
                    kind: "tool",
                    organizationId: address.organizationId,
                  },
                },
                options
              );
            })
          );
        }
        return yield* tryAdapter(() =>
          withDatabase(env, (database) =>
            checkContentDependencies(env, database, context, combined, options)
          )
        ).pipe(Effect.flatMap(fromPortResult));
      });
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
      audit: sendToAuditSink(env.AUDIT_SINK),
      authority,
      checkDependencies: dependencies,
      executor,
      contentDependencies: content.dependencies,
      inheritDependencies: content.inheritDependencies,
      importDependencies: content.importDependencies,
      ownerContext,
      prepareInput: content.prepareInput,
      provider: {
        deadlineMs: modelConfig.deadlineMs,
        maxInputBytes: modelConfig.maxInputBytes,
        maxResponseBytes: modelConfig.maxResponseBytes,
        model,
        provider,
      },
      skills: companySkills,
      toolDependencies: (tool: RegisteredTool) =>
        tryAdapter(() => content.recordTool(tool.id)).pipe(
          Effect.as({ sourceIds: [], toolIds: [tool.id] })
        ),
      tools: readOnly
        ? tools.filter(
            (tool) =>
              tool.definition.effect === "read" && !tool.requiresApproval
          )
        : tools,
    };
  });
