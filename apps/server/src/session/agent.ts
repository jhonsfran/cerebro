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
import { withDatabase } from "@cerebro/db";
import { createAgentRepository } from "@cerebro/db/repositories/agents";
import { channelConversation } from "@cerebro/db/schema/agents";
import { SessionAgent as SessionHost } from "@cerebro/runtime/session-agent";
import type {
  MetadataTransaction,
  SessionHostConfiguration,
} from "@cerebro/runtime/session-agent";
import { and, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { z } from "zod";

import type { WorkerEnv } from "../bindings";
import { slackSettings } from "../channels";
import { runtimeConfiguration } from "../config";
import { createCoordinatorServices } from "./coordination";
import { createExecutionComposition } from "./execution";
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
  metadata: MetadataTransaction,
  importedDependencies?: () => Promise<ContentDependencies>
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
    const execution = yield* createExecutionComposition(
      env,
      storage,
      address,
      address,
      agent,
      ownerPrincipalId,
      metadata,
      false,
      importedDependencies
    );
    return {
      ...execution,
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
    metadata: MetadataTransaction,
    importedDependencies: () => Promise<ContentDependencies>
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
        importedDependencies
      );
    });
  }
}
