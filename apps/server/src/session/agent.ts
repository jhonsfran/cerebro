import { readAcceptedLegacySlackInput } from "@cerebro/channels/legacy-slack-input";
import { isPrimaryConversation } from "@cerebro/channels/primary-conversations";
import { contextByPrincipal } from "@cerebro/channels/security";
import {
  primarySlackBotEvent,
  readSlackPrimaryEvent,
} from "@cerebro/channels/slack-primary-events";
import { RoutedEventAdmissionSchema } from "@cerebro/contracts/bot-routing";
import type { EventAddress } from "@cerebro/contracts/events";
import {
  Denied,
  InvalidInput,
  fromPortResult,
  tryAdapter,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { ReadOptions } from "@cerebro/contracts/port";
import type {
  AgentDefinition,
  ContentDependencies,
} from "@cerebro/contracts/session";
import { ConversationForkOrigin } from "@cerebro/contracts/session-service";
import { SlackEventReferenceSchema } from "@cerebro/contracts/slack-events";
import { TeamEventReturnSchema } from "@cerebro/contracts/team-events";
import {
  SlackThreadSchema,
  TeamReportDeliverySchema,
} from "@cerebro/contracts/work";
import { withDatabase } from "@cerebro/db";
import { createAgentRepository } from "@cerebro/db/repositories/agents";
import type { channelConversation } from "@cerebro/db/schema/agents";
import { SessionAgent as SessionHost } from "@cerebro/runtime/session-agent";
import type {
  DefinitionSelection,
  MetadataTransaction,
  SessionHostConfiguration,
} from "@cerebro/runtime/session-agent";
import { Effect, Schema } from "effect";
import { z } from "zod";

import type { WorkerEnv } from "../bindings";
import { slackSettings } from "../channels";
import { runtimeConfiguration } from "../config";
import { resolveSessionAddress } from "./address";
import {
  createCoordinatorServices,
  requireLegacySourceMatch,
} from "./coordination";
import { createExecutionComposition } from "./execution";
import { requireInspectionRead } from "./inspection-access";
import { readPrivateTeamInspection } from "./inspection-client";
import {
  authenticateIdentityRequest,
  authenticateSessionRequest,
} from "./proof";
import type { SessionIdentity } from "./proof";
import { createSlackNotifier } from "./slack";
import {
  createSlackEventReplies,
  withCurrentSlackAccess,
} from "./slack-event-replies";
import { sourcePrimaryAddress, legacyTimerOrigin } from "./source-primary";

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

export const createRuntimeComposition = (
  env: WorkerEnv,
  storage: DurableObjectStorage,
  address: EventAddress,
  conversation: typeof channelConversation.$inferSelect,
  metadata: MetadataTransaction,
  importedDependencies?: () => Promise<ContentDependencies>,
  selection?: DefinitionSelection
): Effect.Effect<SessionHostConfiguration, ContractFailure> =>
  Effect.gen(function* composeSession() {
    const primary = yield* tryAdapter(() =>
      isPrimaryConversation(conversation)
    );
    const primaryAddress = yield* tryAdapter(() =>
      sourcePrimaryAddress(env, conversation, primary)
    );
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
      selection?.version ??
        persisted?.agent_version ??
        forkOrigin?.agentVersion ??
        "latest"
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
      selection || pin.agent_version === loadedAgent.version
        ? loadedAgent
        : yield* loadAgent(pin.agent_version);
    const execution = yield* createExecutionComposition(
      env,
      storage,
      address,
      address,
      agent,
      ownerPrincipalId,
      metadata,
      false,
      importedDependencies,
      selection?.contentState
    );
    return {
      ...execution,
      primaryAddress,
      legacyTimerOrigin: legacyTimerOrigin(conversation, slack, address),
      publicationPolicy: primary ? "primary" : "pinned",
      reconcileVersion: async (version: number) => {
        storage.sql.exec(
          "UPDATE cerebro_session_metadata SET agent_version=? WHERE session_id=?",
          version,
          address.sessionId
        );
        await storage.sync();
      },
      conversationKind: conversation.kind,
      eventReplies: createSlackEventReplies(env, slack, primary, {
        agent,
        owner: () => Effect.runPromise(execution.ownerContext()),
      }),
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
      coordination: createCoordinatorServices({
        env,
        address,
        agent,
        authority: execution.authority,
        conversation,
        profile: config.coordination,
        contentDependencies: execution.contentDependencies,
        slack,
        ownerContext: execution.ownerContext,
      }),
      ...(slack?.botToken && conversation.kind === "slack"
        ? {
            notify: createSlackNotifier({
              address,
              agent,
              authority: execution.authority,
              checkContent: (context) =>
                Effect.runPromise(
                  execution.checkDependencies(
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
    };
  });

export class IdentityAgent extends SessionHost<WorkerEnv> {
  protected override inspectionAccess() {
    return {
      authorize: (input: Parameters<typeof requireInspectionRead>[1]) =>
        requireInspectionRead(this.env, input),
      team: (input: Parameters<typeof readPrivateTeamInspection>[1]) =>
        readPrivateTeamInspection(this.env, input),
    };
  }
  protected override resolve(request: Request) {
    return Effect.gen({ self: this }, function* resolveRequest() {
      const identity = yield* resolveIdentity(this.ctx.id.name);
      const path = new URL(request.url).pathname;
      if (path === "/slack-targets") {
        yield* tryAdapter(() =>
          authenticateIdentityRequest(
            request,
            runtimeConfiguration(this.env).gatewaySigningKey,
            identity
          )
        );
        const input = yield* Effect.tryPromise({
          catch: () =>
            new InvalidInput({ reason: "The Slack target query is invalid." }),
          try: async () =>
            Schema.decodeUnknownSync(
              Schema.Struct({ thread: SlackThreadSchema }),
              { onExcessProperty: "error" }
            )(await request.clone().json()),
        });
        const context = yield* tryAdapter(() =>
          withCurrentSlackAccess(() =>
            withDatabase(this.env, (database) =>
              contextByPrincipal(
                database,
                identity.organizationId,
                identity.ownerPrincipalId
              )
            )
          )
        );
        return {
          kind: "subscribed-bots" as const,
          context,
          thread: input.thread,
        };
      }
      const resolved = yield* tryAdapter(() =>
        authenticateSessionRequest(
          request,
          runtimeConfiguration(this.env).gatewaySigningKey,
          identity
        )
      );
      const { conversation } = yield* resolveSessionAddress(
        this.env,
        resolved.address,
        identity
      );
      if (path === "/legacy-slack-input") {
        const slack = slackSettings(this.env);
        if (!slack) {
          return yield* Effect.fail(
            new Denied({ code: "revoked", reason: "Slack is not configured." })
          );
        }
        const body = yield* tryAdapter(async () =>
          z
            .strictObject({
              eventKey: z.string().min(1).max(4096),
              callback: z.unknown(),
            })
            .parse(await request.clone().json())
        );
        const accepted = yield* tryAdapter(() =>
          withCurrentSlackAccess(() =>
            withDatabase(this.env, (database) =>
              readAcceptedLegacySlackInput({
                database,
                configuration: slack,
                address: resolved.address,
                eventKey: body.eventKey,
                callback: body.callback,
              })
            )
          )
        );
        if (
          accepted.ownerPrincipalId !== identity.ownerPrincipalId ||
          resolved.context.actor.id !== accepted.ownerPrincipalId ||
          "delegation" in resolved.context
        ) {
          return yield* Effect.fail(
            new Denied({
              code: "unauthorized",
              reason: "The legacy Slack input belongs to another owner.",
            })
          );
        }
        const context = yield* tryAdapter(() =>
          withDatabase(this.env, (database) =>
            contextByPrincipal(
              database,
              identity.organizationId,
              identity.ownerPrincipalId
            )
          )
        );
        return {
          kind: "accepted-legacy-input" as const,
          address: resolved.address,
          context,
          operationId: accepted.operationId,
          text: accepted.text,
        };
      }
      if (path === "/slack-event") {
        const slack = slackSettings(this.env);
        if (!slack) {
          return yield* Effect.fail(
            new Denied({ code: "revoked", reason: "Slack is not configured." })
          );
        }
        const input = yield* Effect.tryPromise({
          catch: () =>
            new InvalidInput({
              reason: "The Slack event reference is invalid.",
            }),
          try: async () =>
            Schema.decodeUnknownSync(SlackEventReferenceSchema, {
              onExcessProperty: "error",
            })(await request.clone().json()),
        });
        const { decision } = yield* tryAdapter(() =>
          withCurrentSlackAccess(() =>
            withDatabase(this.env, (database) =>
              readSlackPrimaryEvent({
                database,
                configuration: slack,
                address: resolved.address,
                eventKey: input.eventKey,
              })
            )
          )
        );
        if (
          decision.ownerPrincipalId !== identity.ownerPrincipalId ||
          resolved.context.actor.id !== decision.ownerPrincipalId
        ) {
          return yield* Effect.fail(
            new Denied({
              code: "unauthorized",
              reason: "The Slack event belongs to another owner.",
            })
          );
        }
        const event = yield* tryAdapter(() =>
          primarySlackBotEvent(decision, resolved.address)
        );
        const action = event.content.text;
        const admission = Schema.decodeUnknownSync(RoutedEventAdmissionSchema)({
          version: 2,
          kind: "event-admission",
          event,
          routing:
            action === "status" || action === "stop"
              ? { kind: "local-control", action }
              : { kind: "automatic" },
        });
        return { kind: "owned-event" as const, ...resolved, admission };
      }
      if (new URL(request.url).pathname === "/team-report") {
        yield* tryAdapter(async () => {
          const delivery = Schema.decodeUnknownSync(TeamReportDeliverySchema, {
            onExcessProperty: "error",
          })(await request.clone().json());
          requireLegacySourceMatch(delivery, conversation);
        });
      }
      if (new URL(request.url).pathname === "/team-event-return") {
        yield* tryAdapter(async () => {
          const delivery = Schema.decodeUnknownSync(TeamEventReturnSchema, {
            onExcessProperty: "error",
          })(await request.clone().json());
          requireLegacySourceMatch(delivery.work, conversation);
        });
      }
      return resolved;
    });
  }

  protected override configure(
    address: EventAddress,
    metadata: MetadataTransaction,
    importedDependencies: () => Promise<ContentDependencies>,
    selection?: DefinitionSelection
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
        metadata,
        importedDependencies,
        selection
      );
    });
  }
}
