import { AuthorityService } from "@cerebro/contracts/authority-service";
import type { EventAddress } from "@cerebro/contracts/events";
import type { DurableHandoff } from "@cerebro/contracts/execution";
import { Denied, InvalidInput, Unavailable } from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { ReadOptions } from "@cerebro/contracts/port";
import type {
  AgentDefinition,
  ContentDependencies,
} from "@cerebro/contracts/session";
import { DomainSnapshot } from "@cerebro/contracts/session-service";
import type { BoundApproval } from "@cerebro/contracts/tool-service";
import { ToolExecutor } from "@cerebro/contracts/tool-service";
import { createAgentRepository } from "@cerebro/db/repositories/agents";
import { channelConversation } from "@cerebro/db/schema/agents";
import { agentAuthorityLayer } from "@cerebro/policy/agent-authority";
import type { SessionHostConfiguration } from "@cerebro/runtime/session-agent";
import { controlledToolLayer } from "@cerebro/tools/broker";
import { createCapabilitySigner } from "@cerebro/tools/capability";
import { createDynamicToolExecutorService } from "@cerebro/tools/dynamic-worker";
import { bindRegisteredTool } from "@cerebro/tools/registry";
import type { Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { and, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { WorkerEnv } from "./env.server";
import { databaseEffect, fromPortResult } from "./port-effect";
import { createRuntimeRegistry } from "./runtime-configuration";
import { SessionContent, sessionContentLayer } from "./runtime-content";
import {
  checkContentDependencies,
  createCurrentAuthority,
  createCurrentAuthorization,
  createCurrentEntitlements,
  runtimeConfiguration,
} from "./runtime-services";
import { withDatabase } from "./services";
import { authenticateSessionRequest } from "./session-proof.ts";

export const GATEWAY_AUDIENCE = "cerebro-trusted-tool-gateway-v1";
const readOptions = (): ReadOptions => ({ deadlineAt: Date.now() + 10_000 });

export const resolveSessionAddress = (
  env: WorkerEnv,
  name: string | undefined
) =>
  databaseEffect(() =>
    withDatabase(env, async (database): Promise<EventAddress> => {
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
      return {
        agentId: id.agent(row.agentId),
        conversationId: id.conversation(row.conversationId),
        organizationId: id.organization(row.organizationId),
        sessionId: id.session(row.sessionId),
      };
    })
  );

export const createRuntimeComposition = (
  env: WorkerEnv,
  storage: DurableObjectStorage,
  address: EventAddress
): Effect.Effect<SessionHostConfiguration, ContractFailure> =>
  Effect.gen(function* composeSession() {
    const config = runtimeConfiguration(env);
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS cerebro_pi_session (id INTEGER PRIMARY KEY CHECK (id=1), state TEXT NOT NULL)"
    );
    const [existing] = storage.sql
      .exec<{ state: string }>(
        "SELECT state FROM cerebro_pi_session WHERE id=1"
      )
      .toArray();
    const persisted = existing
      ? Schema.decodeUnknownSync(DomainSnapshot)(
          JSON.parse(existing.state).snapshot
        )
      : undefined;
    const agent: AgentDefinition = yield* databaseEffect(() =>
      withDatabase(env, (database) =>
        createAgentRepository(database).get(
          address.organizationId,
          address.agentId,
          persisted?.agentVersion ?? "latest",
          readOptions()
        )
      )
    ).pipe(Effect.flatMap(fromPortResult));
    const modelConfig = config.models.find(
      (candidate) => candidate.id === agent.model
    );
    if (!modelConfig) {
      return yield* Effect.fail(
        new InvalidInput({ reason: "The pinned model is not configured." })
      );
    }
    const registry = createRuntimeRegistry(config);
    const registered = yield* Effect.forEach(registry.list(), (entry) =>
      bindRegisteredTool(entry)
    );
    const current = createCurrentAuthority(env);
    const currentAuthority = yield* AuthorityService.pipe(
      Effect.provide(
        agentAuthorityLayer({
          checkSession: (request, options) =>
            databaseEffect(() =>
              withDatabase(env, async (database) => {
                const [conversation] = await database
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
                  !conversation ||
                  conversation.engine !== "pi-v1" ||
                  conversation.retiredAt ||
                  conversation.ownerPrincipalId !== request.context.actor.id
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
      databaseEffect(() =>
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
    const approvalFor = (operationId: string): BoundApproval | undefined => {
      const [row] = storage.sql
        .exec<{ state: string }>(
          "SELECT state FROM cerebro_pi_session WHERE id=1"
        )
        .toArray();
      if (!row) {
        return undefined;
      }
      // The session store is the authority for bound approvals; only its trusted writer owns this JSON.
      const state = JSON.parse(row.state) as {
        handoffs: readonly DurableHandoff[];
      };
      return state.handoffs
        .flatMap((handoff) => handoff.approvals)
        .find((approval) => approval.operationId === operationId);
    };
    const signer = yield* databaseEffect(() =>
      createCapabilitySigner(config.gatewaySigningKey)
    );
    const driver = createDynamicToolExecutorService({
      audience: GATEWAY_AUDIENCE,
      authorizationPolicy: createCurrentAuthorization(env),
      gateway: env.TOOL_GATEWAY,
      loader: env.LOADER,
      registry,
      signer,
    });
    const executor = yield* ToolExecutor.pipe(
      Effect.provide(
        controlledToolLayer({
          address,
          approval: (invocation) =>
            Effect.succeed(approvalFor(invocation.operationId)),
          authority,
          checkApprover: (approval, invocation, options) =>
            Effect.gen(function* currentApprover() {
              const context = yield* databaseEffect(() =>
                withDatabase(env, async (database) => {
                  const { contextByPrincipal } =
                    await import("@cerebro/channels/security");
                  return await contextByPrincipal(
                    database,
                    address.organizationId,
                    approval.approverId
                  );
                })
              );
              yield* current.require(
                {
                  action: "approve",
                  address,
                  context,
                  pinnedAgent: agent,
                  resource: {
                    id: agent.agentId,
                    kind: "agent",
                    organizationId: address.organizationId,
                  },
                },
                options
              );
              if (approval.operationId !== invocation.operationId) {
                return yield* Effect.fail(
                  new Denied({
                    code: "approval-required",
                    reason: "Approval identity changed.",
                  })
                );
              }
            }),
          driver,
          pinnedAgent: agent,
          registry,
        })
      )
    );
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
      content: content.content,
      executor,
      prepareInput: content.prepareInput,
      projectAudit: (event) =>
        databaseEffect(async () => {
          const response = await env.AUDIT_SINK.fetch(
            new Request("https://audit.internal/project", {
              body: JSON.stringify(event),
              headers: { "Content-Type": "application/json" },
              method: "POST",
              signal: AbortSignal.timeout(10_000),
            })
          );
          if (!response.ok) {
            throw new Unavailable({
              reason: "Audit sink did not acknowledge the event",
            });
          }
        }),
      provider: {
        beforeFetch: () => content.beforeFetch(),
        deadlineMs: modelConfig.deadlineMs,
        maxInputBytes: modelConfig.maxInputBytes,
        model,
        provider,
      },
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
