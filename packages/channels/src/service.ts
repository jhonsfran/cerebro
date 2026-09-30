/* oxlint-disable no-await-in-loop -- Current permission reads and effects share one request-scoped PostgreSQL connection. */
import { id } from "@cerebro/contracts";
import type {
  Action,
  AgentDefinition,
  AgentGrant,
  EventAddress,
  ExecutionContext,
  SessionReceipt,
} from "@cerebro/contracts";
import type { Database } from "@cerebro/db";
import {
  createAgentRepository,
  listAgentMetadata,
  publishAgentConfiguration,
  readAgentMetadata,
} from "@cerebro/db/repositories/agents";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import {
  channelConversation,
  channelEffect,
  channelFixtureRun,
  channelInbox,
  channelItem,
  installationSetup,
} from "@cerebro/db/schema/agents";
import { organization } from "@cerebro/db/schema/core";
import {
  identityGrant,
  identityPolicyRevision,
  identityPrincipal,
} from "@cerebro/db/schema/identity";
import { and, asc, eq, gt, sql } from "drizzle-orm";

import { sessionServiceFor } from "./fixture-session";
import {
  authorize,
  authorizeContent,
  contextByPrincipal,
  digest,
  trustedSetupCredential,
  principalContext,
  unwrap,
} from "./security";
import {
  ChannelError,
  EFFECT_DEADLINE_MS,
  FIXTURE_MODEL_ID,
  FIXTURE_SOURCE_ID,
  FIXTURE_TOOL_ID,
  INSTALLATION_AGENT_PREFIX,
} from "./types";
import type {
  AccessAction,
  ChannelOptions,
  ChannelPresentationItem,
} from "./types";

export type Conversation = typeof channelConversation.$inferSelect;
export interface AgentInput {
  readonly operationId: string;
  readonly name: string;
  readonly instructions: string;
  readonly model: string;
  readonly enabledToolIds: readonly string[];
  readonly grants: readonly AgentGrant[];
  readonly expectedVersion?: number;
}
const conversationAddress = (row: Conversation): EventAddress => ({
  agentId: id.agent(row.agentId),
  conversationId: id.conversation(row.conversationId),
  organizationId: id.organization(row.organizationId),
  sessionId: id.session(row.sessionId),
});
const same = (
  row: Conversation,
  options: ChannelOptions,
  context: ExecutionContext
): boolean =>
  row.organizationId === options.organizationId &&
  row.ownerPrincipalId === context.actor.id;

export const createChannelService = (
  database: Database,
  options: ChannelOptions
) => {
  const now = options.now ?? Date.now;
  const readOptions = () => ({ deadlineAt: now() + EFFECT_DEADLINE_MS });
  const current = (userId: string) =>
    principalContext(database, options.organizationId, userId);
  const requireConversation = async (
    conversationId: string,
    context: ExecutionContext,
    action: Action
  ) => {
    const [row] = await database
      .select()
      .from(channelConversation)
      .where(eq(channelConversation.conversationId, conversationId));
    if (!row || !same(row, options, context)) {
      throw new ChannelError(
        404,
        "not-found",
        "The conversation was not found."
      );
    }
    await authorize(database, options, context, action, "agent", row.agentId);
    return row;
  };
  const setup = async (userId: string) => {
    const [record] = await database
      .select()
      .from(installationSetup)
      .where(eq(installationSetup.id, "installation"));
    const principal = await createIdentityRepository(
      database
    ).findPrincipalByUser(options.organizationId, userId);
    return {
      bootstrapTokenRequired:
        options.mode !== "fixture" && Boolean(options.bootstrapToken),
      mode: options.mode,
      organizationId: options.organizationId,
      owner: record?.ownerUserId === userId,
      principalId: principal?.id ?? null,
      setupRequired: !record,
    };
  };
  const install = async (userId: string, bootstrapToken?: string) => {
    await database.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('cerebro-installation-setup'))`
      );
      const [existing] = await tx
        .select()
        .from(installationSetup)
        .where(eq(installationSetup.id, "installation"));
      if (existing) {
        if (
          existing.ownerUserId !== userId ||
          existing.organizationId !== options.organizationId
        ) {
          throw new ChannelError(
            403,
            "forbidden",
            "The installation already has an owner."
          );
        }
        return;
      }
      if (
        options.mode !== "fixture" &&
        !(await trustedSetupCredential(options, userId, bootstrapToken))
      ) {
        throw new ChannelError(
          403,
          "unauthorized",
          "Trusted installation setup is required."
        );
      }
      await tx
        .insert(organization)
        .values({ id: options.organizationId, name: "Local company" })
        .onConflictDoNothing();
      const [existingPrincipal] = await tx
        .select()
        .from(identityPrincipal)
        .where(
          and(
            eq(identityPrincipal.organizationId, options.organizationId),
            eq(identityPrincipal.betterAuthUserId, userId)
          )
        );
      if (
        existingPrincipal &&
        (existingPrincipal.state !== "active" ||
          existingPrincipal.kind !== "human" ||
          existingPrincipal.directoryManaged)
      ) {
        throw new ChannelError(
          403,
          "forbidden",
          "An active local human principal is required for installation setup."
        );
      }
      const principalId = existingPrincipal?.id ?? crypto.randomUUID();
      if (!existingPrincipal) {
        await tx.insert(identityPrincipal).values({
          betterAuthUserId: userId,
          id: principalId,
          kind: "human",
          organizationId: options.organizationId,
          state: "active",
        });
      }
      await tx.insert(identityGrant).values([
        {
          action: "manage",
          organizationId: options.organizationId,
          principalId,
          resourceId: `${INSTALLATION_AGENT_PREFIX}${options.organizationId}`,
          resourceKind: "agent",
          source:
            options.mode === "fixture" ? "fixture-owner" : "installation-owner",
        },
        {
          action: "read",
          organizationId: options.organizationId,
          principalId,
          resourceId: options.organizationId,
          resourceKind: "budget",
          source:
            options.mode === "fixture" ? "fixture-owner" : "installation-owner",
        },
        {
          action: "read",
          organizationId: options.organizationId,
          principalId,
          resourceId: options.organizationId,
          resourceKind: "audit",
          source:
            options.mode === "fixture" ? "fixture-owner" : "installation-owner",
        },
        ...(options.mode === "fixture"
          ? [
              {
                action: "read" as const,
                organizationId: options.organizationId,
                principalId,
                resourceId: FIXTURE_TOOL_ID,
                resourceKind: "tool" as const,
                source: "fixture-owner",
              },
              {
                action: "execute" as const,
                organizationId: options.organizationId,
                principalId,
                resourceId: FIXTURE_TOOL_ID,
                resourceKind: "tool" as const,
                source: "fixture-owner",
              },
              {
                action: "execute" as const,
                organizationId: options.organizationId,
                principalId,
                resourceId: "fixture-connector",
                resourceKind: "tool" as const,
                source: "fixture-owner",
              },
              {
                action: "read" as const,
                organizationId: options.organizationId,
                principalId,
                resourceId: FIXTURE_SOURCE_ID,
                resourceKind: "memory" as const,
                source: "fixture-owner",
              },
            ]
          : []),
      ]);
      await tx.insert(installationSetup).values({
        id: "installation",
        organizationId: options.organizationId,
        ownerPrincipalId: principalId,
        ownerUserId: userId,
      });
    });
    return setup(userId);
  };
  const catalog = async (userId: string) => {
    const context = await current(userId);
    if (options.catalogFor) {
      const configured = unwrap(await options.catalogFor(database, context));
      return { ...configured, sourceChoices: configured.sourceChoices ?? [] };
    }
    if (options.catalog) {
      return {
        ...options.catalog,
        sourceChoices: options.catalog.sourceChoices ?? [],
      };
    }
    if (options.mode === "fixture" && !options.sessions) {
      return {
        connectorChoices: [
          { id: FIXTURE_TOOL_ID, label: "Local pilot source" },
        ],
        modelChoices: [
          { id: FIXTURE_MODEL_ID, label: "Deterministic local fixture" },
        ],
      };
    }
    throw new ChannelError(
      503,
      "provider-unavailable",
      "The agent catalog is not configured."
    );
  };
  const publishAgent = async (
    userId: string,
    input: AgentInput,
    agentId?: string
  ) => {
    const context = await current(userId);
    await authorize(
      database,
      options,
      context,
      "manage",
      "agent",
      agentId ?? `${INSTALLATION_AGENT_PREFIX}${options.organizationId}`
    );
    const configured = await catalog(userId);
    if (
      !configured.modelChoices.some((choice) => choice.id === input.model) ||
      input.enabledToolIds.some(
        (tool) =>
          !configured.connectorChoices.some((choice) => choice.id === tool)
      )
    ) {
      throw new ChannelError(
        422,
        "invalid-input",
        "Select configured models and connectors."
      );
    }
    for (const toolId of input.enabledToolIds) {
      await authorize(database, options, context, "read", "tool", toolId);
    }
    for (const grant of input.grants) {
      if (
        grant.resource.organizationId !== options.organizationId ||
        grant.resource.id === "*"
      ) {
        throw new ChannelError(
          422,
          "invalid-input",
          "An agent grant must name a company resource."
        );
      }
      await authorize(
        database,
        options,
        context,
        grant.action,
        grant.resource.kind,
        grant.resource.id
      );
    }
    const selectedAgentId =
      agentId ??
      `agent:${await digest({ operationId: input.operationId, principalId: context.actor.id })}`;
    const expectedVersion = agentId ? input.expectedVersion : undefined;
    if (agentId && expectedVersion === undefined) {
      throw new ChannelError(
        422,
        "invalid-input",
        "An update requires the expected version."
      );
    }
    const definition: AgentDefinition = {
      agentId: id.agent(selectedAgentId),
      enabledToolIds: input.enabledToolIds,
      grants: input.grants,
      instructions: input.instructions,
      model: input.model,
      organizationId: id.organization(options.organizationId),
      version: (expectedVersion ?? 0) + 1,
    };
    const result = unwrap(
      await publishAgentConfiguration(
        database,
        definition,
        expectedVersion,
        {
          ...readOptions(),
          operationId: id.operation(
            `publish:${context.actor.id}:${input.operationId}`
          ),
          requestDigest: id.digest(
            await digest({
              definition,
              expectedVersion: expectedVersion ?? null,
              name: input.name,
            })
          ),
        },
        {
          creatorPrincipalId: agentId ? undefined : context.actor.id,
          name: input.name,
        }
      )
    );
    return { agentId: selectedAgentId, version: result.version };
  };
  const listAgents = async (userId: string) => {
    const context = await current(userId);
    const rows = await listAgentMetadata(database, options.organizationId);
    const visible: {
      agentId: string;
      name: string;
      version: number;
      model: string;
      canManage: boolean;
    }[] = [];
    for (const row of rows) {
      try {
        await authorize(
          database,
          options,
          context,
          "read",
          "agent",
          row.agentId
        );
      } catch (error) {
        if (error instanceof ChannelError && error.status === 403) {
          continue;
        }
        throw error;
      }
      let canManage = true;
      try {
        await authorize(
          database,
          options,
          context,
          "manage",
          "agent",
          row.agentId
        );
      } catch (error) {
        if (error instanceof ChannelError && error.status === 403) {
          canManage = false;
        } else {
          throw error;
        }
      }
      const definition = unwrap(
        await createAgentRepository(database).get(
          id.organization(options.organizationId),
          id.agent(row.agentId),
          "latest",
          readOptions()
        )
      );
      visible.push({
        agentId: row.agentId,
        canManage,
        model: definition.model,
        name: row.name,
        version: row.currentVersion,
      });
    }
    return { agents: visible };
  };
  const getAgent = async (userId: string, agentId: string) => {
    const context = await current(userId);
    await authorize(database, options, context, "read", "agent", agentId);
    const metadata = await readAgentMetadata(
      database,
      options.organizationId,
      agentId
    );
    if (!metadata) {
      throw new ChannelError(404, "not-found", "The agent was not found.");
    }
    const definition = unwrap(
      await createAgentRepository(database).get(
        id.organization(options.organizationId),
        id.agent(agentId),
        "latest",
        readOptions()
      )
    );
    let canManage = true;
    try {
      await authorize(database, options, context, "manage", "agent", agentId);
    } catch (error) {
      if (error instanceof ChannelError && error.status === 403) {
        canManage = false;
      } else {
        throw error;
      }
    }
    const access: {
      principalId: string;
      name: string;
      actions: AccessAction[];
    }[] = [];
    if (canManage) {
      const principals = await database
        .select()
        .from(identityPrincipal)
        .where(eq(identityPrincipal.organizationId, options.organizationId));
      const grants = await database
        .select()
        .from(identityGrant)
        .where(
          and(
            eq(identityGrant.organizationId, options.organizationId),
            eq(identityGrant.resourceKind, "agent"),
            eq(identityGrant.resourceId, agentId)
          )
        );
      for (const principal of principals) {
        const actions: AccessAction[] = [];
        for (const action of ["read", "execute", "approve"] as const) {
          if (
            grants.some(
              (grant) =>
                grant.principalId === principal.id && grant.action === action
            )
          ) {
            actions.push(action);
          }
        }
        access.push({
          actions,
          name: principal.betterAuthUserId ?? principal.id,
          principalId: principal.id,
        });
      }
    }
    return {
      access,
      agentId,
      canManage,
      ...(await catalog(userId)),
      definition,
      name: metadata.name,
    };
  };
  const setAccess = async (
    userId: string,
    agentId: string,
    principalId: string,
    actions: readonly AccessAction[],
    operationId: string
  ) => {
    const context = await current(userId);
    await authorize(database, options, context, "manage", "agent", agentId);
    await contextByPrincipal(database, options.organizationId, principalId);
    const effectId = `access:${options.organizationId}:${context.actor.id}:${operationId}`;
    const requestDigest = await digest({
      actions: [...actions].toSorted(),
      agentId,
      principalId,
    });
    return database.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${effectId}))`
      );
      const [prior] = await tx
        .select()
        .from(channelEffect)
        .where(eq(channelEffect.operationId, effectId));
      if (prior) {
        if (
          prior.digest !== requestDigest ||
          !("principalId" in prior.result)
        ) {
          throw new ChannelError(
            409,
            "digest-mismatch",
            "The access operation changed."
          );
        }
        return prior.result;
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${options.organizationId}), hashtext(${principalId + agentId}))`
      );
      await tx
        .delete(identityGrant)
        .where(
          and(
            eq(identityGrant.organizationId, options.organizationId),
            eq(identityGrant.principalId, principalId),
            eq(identityGrant.resourceKind, "agent"),
            eq(identityGrant.resourceId, agentId),
            eq(identityGrant.source, "manual"),
            sql`${identityGrant.action} in ('read', 'execute', 'approve')`
          )
        );
      if (actions.length > 0) {
        await tx
          .insert(identityGrant)
          .values(
            actions.map((action) => ({
              action,
              organizationId: options.organizationId,
              principalId,
              resourceId: agentId,
              resourceKind: "agent" as const,
              source: "manual",
            }))
          )
          .onConflictDoNothing();
      }
      await tx
        .insert(identityPolicyRevision)
        .values({ organizationId: options.organizationId, version: 1 })
        .onConflictDoUpdate({
          set: { version: sql`${identityPolicyRevision.version} + 1` },
          target: identityPolicyRevision.organizationId,
        });
      const result = { actions, principalId, source: "manual" as const };
      await tx
        .insert(channelEffect)
        .values({ digest: requestDigest, operationId: effectId, result });
      return result;
    });
  };
  const createConversation = async (
    userId: string,
    agentId: string,
    operationId: string
  ) => {
    const context = await current(userId);
    await authorize(database, options, context, "execute", "agent", agentId);
    unwrap(
      await createAgentRepository(database).get(
        id.organization(options.organizationId),
        id.agent(agentId),
        "latest",
        readOptions()
      )
    );
    const bindingKey = `web:${await digest({ operationId, organizationId: options.organizationId, principalId: context.actor.id })}`;
    const conversationId = `conversation:${await digest(bindingKey)}`;
    await database
      .insert(channelConversation)
      .values({
        agentId,
        bindingKey,
        conversationId,
        kind: "web",
        organizationId: options.organizationId,
        ownerPrincipalId: context.actor.id,
        sessionId: `session:${await digest({ agentId, conversationId, organizationId: options.organizationId })}`,
      })
      .onConflictDoNothing();
    const row = await requireConversation(conversationId, context, "execute");
    if (row.agentId !== agentId) {
      throw new ChannelError(
        409,
        "conflict",
        "The conversation operation names another agent."
      );
    }
    return {
      agentId: row.agentId,
      conversationId: row.conversationId,
      sessionId: row.sessionId,
    };
  };
  const admit = async (
    conversation: Conversation,
    context: ExecutionContext,
    eventKey: string,
    text: string
  ): Promise<SessionReceipt> => {
    await authorize(
      database,
      options,
      context,
      "execute",
      "agent",
      conversation.agentId
    );
    const contentDigest = await digest({
      address: conversationAddress(conversation),
      principalId: context.actor.id,
      text,
    });
    const eventId = id.event(`event:${await digest(eventKey)}`);
    const envelope = {
      ...conversationAddress(conversation),
      context,
      event: { payload: { text }, type: "user.message" as const },
      eventId,
      occurredAt: now(),
      payloadDigest: id.digest(contentDigest),
      schemaVersion: 1 as const,
    };
    const row = await database.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${eventKey}))`
      );
      const [prior] = await tx
        .select()
        .from(channelInbox)
        .where(eq(channelInbox.eventKey, eventKey));
      if (prior) {
        if (prior.digest !== contentDigest) {
          throw new ChannelError(
            409,
            "digest-mismatch",
            "The event ID has different message content."
          );
        }
        return prior;
      }
      const [inserted] = await tx
        .insert(channelInbox)
        .values({
          conversationId: conversation.conversationId,
          digest: contentDigest,
          envelope,
          eventKey,
          organizationId: options.organizationId,
          state: "pending",
        })
        .returning();
      if (!inserted) {
        throw new Error("The inbox insert returned no row.");
      }
      await tx
        .update(channelConversation)
        .set({
          activityVersion: sql`${channelConversation.activityVersion} + 1`,
          projectionState: "active",
        })
        .where(
          eq(channelConversation.conversationId, conversation.conversationId)
        );
      return inserted;
    });
    if (row.receipt) {
      return { ...row.receipt, replayed: true };
    }
    const receipt = unwrap(
      await sessionServiceFor(database, options).submit(
        { event: row.envelope, type: "submit" },
        {
          ...readOptions(),
          operationId: id.operation(`submit:${row.envelope.eventId}`),
          requestDigest: id.digest(row.digest),
        }
      )
    );
    await database
      .update(channelInbox)
      .set({ receipt, state: "accepted" })
      .where(eq(channelInbox.eventKey, eventKey));
    return receipt;
  };
  const submit = async (
    userId: string,
    conversationId: string,
    eventId: string,
    text: string
  ) => {
    const context = await current(userId);
    const row = await requireConversation(conversationId, context, "execute");
    const receipt = await admit(
      row,
      context,
      `web:${options.organizationId}:${conversationId}:${context.actor.id}:${eventId}`,
      text
    );
    const items = await database
      .select({ cursor: channelItem.cursor })
      .from(channelItem)
      .where(eq(channelItem.conversationId, conversationId))
      .orderBy(asc(channelItem.cursor));
    return { cursor: String(items.at(-1)?.cursor ?? 0), receipt };
  };
  const readConversation = async (
    userId: string,
    conversationId: string,
    cursor?: string
  ) => {
    const context = await current(userId);
    const row = await requireConversation(conversationId, context, "read");
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ChannelError(
        422,
        "invalid-input",
        "The stream cursor is invalid."
      );
    }
    const snapshot = unwrap(
      await sessionServiceFor(database, options).inspect(
        conversationAddress(row),
        context,
        readOptions()
      )
    );
    const records = await database
      .select()
      .from(channelItem)
      .where(
        and(
          eq(channelItem.organizationId, options.organizationId),
          eq(channelItem.conversationId, conversationId),
          gt(channelItem.cursor, offset)
        )
      )
      .orderBy(asc(channelItem.cursor))
      .limit(200);
    const items: ChannelPresentationItem[] = [];
    for (const record of records) {
      await authorize(database, options, context, "read", "agent", row.agentId);
      await authorizeContent(database, options, context, record.item);
      items.push({ ...record.item, cursor: String(record.cursor) });
    }
    return {
      agentId: row.agentId,
      conversationId,
      cursor: items.at(-1)?.cursor ?? cursor ?? "0",
      items,
      mode: options.mode,
      sessionId: row.sessionId,
      snapshot,
    };
  };
  const listConversations = async (userId: string) => {
    const context = await current(userId);
    const rows = await database
      .select()
      .from(channelConversation)
      .where(
        and(
          eq(channelConversation.organizationId, options.organizationId),
          eq(channelConversation.ownerPrincipalId, context.actor.id)
        )
      )
      .orderBy(asc(channelConversation.createdAt));
    const conversations: Conversation[] = [];
    for (const row of rows) {
      try {
        await authorize(
          database,
          options,
          context,
          "read",
          "agent",
          row.agentId
        );
        conversations.push(row);
      } catch (error) {
        if (!(error instanceof ChannelError && error.status === 403)) {
          throw error;
        }
      }
    }
    return { conversations };
  };
  const approve = async (
    userId: string,
    conversationId: string,
    approvalId: string,
    operationId: string
  ) => {
    const context = await current(userId);
    const row = await requireConversation(conversationId, context, "approve");
    const command = {
      address: conversationAddress(row),
      approvalId,
      context,
      type: "approve" as const,
    };
    return {
      run: unwrap(
        await sessionServiceFor(database, options).approve(command, {
          ...readOptions(),
          operationId: id.operation(
            `approve:${context.actor.id}:${operationId}`
          ),
          requestDigest: id.digest(await digest(command)),
        })
      ),
    };
  };
  const cancel = async (
    userId: string,
    conversationId: string,
    runId: string,
    operationId: string
  ) => {
    const context = await current(userId);
    const row = await requireConversation(conversationId, context, "execute");
    const command = {
      address: conversationAddress(row),
      context,
      runId: id.run(runId),
      type: "cancel" as const,
    };
    return {
      run: unwrap(
        await sessionServiceFor(database, options).cancel(command, {
          ...readOptions(),
          operationId: id.operation(
            `cancel:${context.actor.id}:${operationId}`
          ),
          requestDigest: id.digest(await digest(command)),
        })
      ),
    };
  };
  const history = async (userId: string, conversationId: string) => {
    const view = await readConversation(userId, conversationId);
    return {
      projectionStatus:
        options.mode === "fixture" ? "fixture" : "eventually-consistent",
      runs: view.snapshot.runs.map((run) => ({
        auditHref: `/api/product/conversations/${conversationId}/audit/${run.runId}`,
        runId: run.runId,
        state: run.state,
      })),
    };
  };
  const source = async (
    userId: string,
    conversationId: string,
    sourceId: string
  ) => {
    const context = await current(userId);
    const conversation = await requireConversation(
      conversationId,
      context,
      "read"
    );
    if (options.readSource) {
      await authorize(database, options, context, "read", "memory", sourceId);
      return {
        ...unwrap(
          await options.readSource(database, context, {
            conversationId,
            sessionId: conversation.sessionId,
            sourceId,
          })
        ),
        mode: options.mode,
      };
    }
    if (options.mode !== "fixture" || options.sessions) {
      throw new ChannelError(
        503,
        "provider-unavailable",
        "The source adapter is not configured."
      );
    }
    if (sourceId !== FIXTURE_SOURCE_ID) {
      throw new ChannelError(404, "not-found", "The source was not found.");
    }
    return {
      mode: "fixture",
      sourceId,
      sourceVersion: "1",
      text: "Cerebro admits each conversation event with a stable ID. Retries reuse the stored envelope. Current permissions apply to every read and action. This source is a local fixture, not company retrieval.",
      title: "Local pilot source",
    };
  };
  const audit = async (
    userId: string,
    conversationId: string,
    runId: string
  ) => {
    const context = await current(userId);
    const conversation = await requireConversation(
      conversationId,
      context,
      "read"
    );
    await authorize(
      database,
      options,
      context,
      "read",
      "audit",
      options.organizationId
    );
    if (options.readAudit) {
      return {
        ...unwrap(
          await options.readAudit(database, context, {
            conversationId,
            runId,
            sessionId: conversation.sessionId,
          })
        ),
        mode: options.mode,
      };
    }
    if (options.mode !== "fixture" || options.sessions) {
      throw new ChannelError(
        503,
        "provider-unavailable",
        "The audit adapter is not configured."
      );
    }
    const [record] = await database
      .select()
      .from(channelFixtureRun)
      .where(
        and(
          eq(channelFixtureRun.organizationId, options.organizationId),
          eq(channelFixtureRun.conversationId, conversationId),
          eq(channelFixtureRun.runId, runId)
        )
      );
    if (!record) {
      throw new ChannelError(404, "not-found", "The run was not found.");
    }
    let endedAt = record.envelope.occurredAt;
    if (record.state.state === "completed") {
      endedAt = record.state.completedAt;
    } else if (
      record.state.state === "cancelled" ||
      record.state.state === "failed"
    ) {
      const { endedAt: terminalAt } = record.state;
      endedAt = terminalAt;
    }
    return {
      entries: [
        {
          at: record.envelope.occurredAt,
          description: "The stable conversation event was accepted.",
          type: "admission",
        },
        {
          at: endedAt,
          description: `The run state is ${record.state.state}.`,
          type: "state",
        },
      ],
      mode: "fixture",
      runId,
      state: record.state.state,
    };
  };
  const budget = async (userId: string) => {
    const context = await current(userId);
    await authorize(
      database,
      options,
      context,
      "read",
      "budget",
      options.organizationId
    );
    if (options.budget) {
      return {
        mode: options.mode,
        remaining: unwrap(
          await options.budget.inspect(
            id.organization(options.organizationId),
            readOptions()
          )
        ),
      };
    }
    if (options.mode !== "fixture" || options.sessions) {
      throw new ChannelError(
        503,
        "provider-unavailable",
        "The budget adapter is not configured."
      );
    }
    return { mode: "fixture", remaining: { unit: "credits", units: 1000 } };
  };
  return {
    admit,
    approve,
    audit,
    budget,
    cancel,
    catalog,
    createConversation,
    getAgent,
    history,
    install,
    listAgents,
    listConversations,
    publishAgent,
    readConversation,
    setAccess,
    setup,
    source,
    submit,
  };
};
export type ChannelService = ReturnType<typeof createChannelService>;
export { conversationAddress };
