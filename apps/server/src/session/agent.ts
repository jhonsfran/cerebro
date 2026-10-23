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
import { ConversationForkOrigin } from "@cerebro/contracts/session-service";
import { withDatabase } from "@cerebro/db";
import { findSealedAccount } from "@cerebro/db/repositories/accounts";
import { createAgentRepository } from "@cerebro/db/repositories/agents";
import { listSkills } from "@cerebro/db/repositories/skills";
import { channelConversation } from "@cerebro/db/schema/agents";
import { SessionAgent as SessionHost } from "@cerebro/runtime/session-agent";
import type {
  MetadataTransaction,
  SessionHostConfiguration,
} from "@cerebro/runtime/session-agent";
import { connectorAccountId, openCredentials } from "@cerebro/tools/accounts";
import { createConnectorExecutor } from "@cerebro/tools/connector";
import { bindRegisteredTool } from "@cerebro/tools/registry";
import type { Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { and, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { z } from "zod";

import {
  checkContentDependencies,
  createCurrentAuthority,
  createCurrentEntitlements,
} from "../access";
import type { WorkerEnv } from "../bindings";
import { catalogTools } from "../catalog";
import { slackSettings } from "../channels";
import { createCatalogRegistry, runtimeConfiguration } from "../config";
import { SessionContent, sessionContentLayer } from "./content";
import { authenticateSessionRequest } from "./proof";
import type { SessionIdentity } from "./proof";
import { createSlackNotifier } from "./slack";

const readOptions = (): ReadOptions => ({ deadlineAt: Date.now() + 10_000 });
const identityName = z.tuple([
  z.string().min(1).max(512),
  z.string().min(1).max(512),
]);
const resolveIdentity = (name: string | undefined) =>
  Effect.try({
    catch: () =>
      new Denied({ code: "unauthorized", reason: "Invalid identity host." }),
    try: (): SessionIdentity => {
      const [organizationId, ownerPrincipalId] = identityName.parse(
        JSON.parse(name ?? "null")
      );
      return {
        organizationId: id.organization(organizationId),
        ownerPrincipalId: id.principal(ownerPrincipalId),
      };
    },
  });

export const resolveSessionAddress = (
  env: WorkerEnv,
  address: EventAddress,
  identity: SessionIdentity
) =>
  tryAdapter(() =>
    withDatabase(env, async (database) => {
      const [row] = await database
        .select()
        .from(channelConversation)
        .where(
          and(
            eq(channelConversation.organizationId, address.organizationId),
            eq(channelConversation.agentId, address.agentId),
            eq(channelConversation.conversationId, address.conversationId),
            eq(channelConversation.sessionId, address.sessionId)
          )
        );
      if (
        !row ||
        row.engine !== "pi-identity-v1" ||
        row.retiredAt ||
        row.organizationId !== identity.organizationId ||
        row.ownerPrincipalId !== identity.ownerPrincipalId
      ) {
        throw new Denied({
          code: "unauthorized",
          reason: "The identity does not own this active conversation.",
        });
      }
      return { address, conversation: row };
    })
  );

export const createRuntimeComposition = (
  env: WorkerEnv,
  storage: DurableObjectStorage,
  address: EventAddress,
  conversation: typeof channelConversation.$inferSelect,
  metadata: MetadataTransaction
): Effect.Effect<SessionHostConfiguration, ContractFailure> =>
  Effect.gen(function* composeSession() {
    const config = runtimeConfiguration(env);
    const slack = slackSettings(env);
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS cerebro_session_metadata (session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation_id TEXT NOT NULL, agent_version INTEGER NOT NULL, owner_principal_id TEXT NOT NULL)"
    );
    const readPin = () =>
      storage.sql
        .exec<{
          agent_id: string;
          conversation_id: string;
          agent_version: number;
          owner_principal_id: string;
        }>(
          "SELECT agent_id, conversation_id, agent_version, owner_principal_id FROM cerebro_session_metadata WHERE session_id=?",
          address.sessionId
        )
        .toArray()[0];
    const persisted = readPin();
    const { ownerPrincipalId } = conversation;
    const loadAgent = (version: number | "latest") =>
      tryAdapter(() =>
        withDatabase(env, (database) =>
          createAgentRepository(database).get(
            address.organizationId,
            address.agentId,
            version,
            readOptions()
          )
        )
      ).pipe(Effect.flatMap(fromPortResult));
    const forkOrigin = conversation.forkOrigin
      ? yield* Effect.try({
          catch: () =>
            new InvalidInput({ reason: "Invalid conversation fork origin." }),
          try: () =>
            Schema.decodeUnknownSync(ConversationForkOrigin)(
              conversation.forkOrigin
            ),
        })
      : undefined;
    const loadedAgent = yield* loadAgent(
      persisted?.agent_version ?? forkOrigin?.agentVersion ?? "latest"
    );
    storage.sql.exec(
      "INSERT OR IGNORE INTO cerebro_session_metadata VALUES (?, ?, ?, ?, ?)",
      address.sessionId,
      address.agentId,
      address.conversationId,
      loadedAgent.version,
      ownerPrincipalId
    );
    const pin = readPin();
    if (
      !pin ||
      pin.agent_id !== address.agentId ||
      pin.conversation_id !== address.conversationId ||
      pin.owner_principal_id !== ownerPrincipalId
    ) {
      return yield* Effect.fail(
        new Denied({
          code: "unauthorized",
          reason: "The conversation execution identity changed.",
        })
      );
    }
    const agent: AgentDefinition =
      pin.agent_version === loadedAgent.version
        ? loadedAgent
        : yield* loadAgent(pin.agent_version);
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
        sessionContentLayer(env, storage, address, agent, metadata)
      ),
      Effect.provideService(AuthorityService, authority)
    );
    const dependencies = (
      context: ExecutionContext,
      requested: ContentDependencies,
      options: ReadOptions
    ) =>
      Effect.gen(function* checkDependencies() {
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
        return yield* tryAdapter(() =>
          withDatabase(env, (database) =>
            checkContentDependencies(
              env,
              database,
              context,
              {
                sourceIds: [
                  ...new Set([...requested.sourceIds, ...recorded.sourceIds]),
                ],
                toolIds: [
                  ...new Set([...requested.toolIds, ...recorded.toolIds]),
                ],
              },
              options
            )
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
      ...(forkOrigin
        ? {
            origin: {
              address: {
                ...address,
                conversationId: id.conversation(
                  forkOrigin.parentConversationId
                ),
                sessionId: id.session(forkOrigin.parentSessionId),
              },
              agentVersion: forkOrigin.agentVersion,
              entryId: forkOrigin.entryId,
            },
          }
        : {}),
      agent,
      authority,
      checkDependencies: dependencies,
      executor,
      contentDependencies: content.dependencies,
      inheritDependencies: content.inheritDependencies,
      ...(slack?.botToken && conversation?.kind === "slack"
        ? {
            notify: createSlackNotifier({
              address,
              agent,
              authority,
              checkContent: (context) =>
                Effect.runPromise(
                  dependencies(
                    context,
                    { sourceIds: [], toolIds: [] },
                    readOptions()
                  )
                ),
              conversation,
              env,
              slack,
              storage,
              metadata,
            }),
          }
        : {}),
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
      toolDependencies: (tool) =>
        tryAdapter(() => content.recordTool(tool.id)).pipe(
          Effect.as({ sourceIds: [], toolIds: [tool.id] })
        ),
      tools,
    };
  });

export class IdentityAgent extends SessionHost<WorkerEnv> {
  protected override resolve(request: Request) {
    return Effect.gen({ self: this }, function* resolveRequest() {
      const identity = yield* resolveIdentity(this.ctx.id.name);
      const resolved = yield* tryAdapter(() =>
        authenticateSessionRequest(
          request,
          runtimeConfiguration(this.env).gatewaySigningKey,
          identity
        )
      );
      yield* resolveSessionAddress(this.env, resolved.address, identity);
      return resolved;
    });
  }

  protected override configure(
    address: EventAddress,
    metadata: MetadataTransaction
  ) {
    return Effect.gen({ self: this }, function* configureConversation() {
      const identity = yield* resolveIdentity(this.ctx.id.name);
      const { conversation } = yield* resolveSessionAddress(
        this.env,
        address,
        identity
      );
      return yield* createRuntimeComposition(
        this.env,
        this.ctx.storage,
        address,
        conversation,
        metadata
      );
    });
  }
}
