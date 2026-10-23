/* oxlint-disable no-await-in-loop -- Current permission reads and effects share one request-scoped PostgreSQL connection. */
import { id } from "@cerebro/contracts";
import type { AgentDefinition, AgentGrant } from "@cerebro/contracts";
import type { Database } from "@cerebro/db";
import {
  createAgentRepository,
  listAgentMetadata,
  publishAgentConfiguration,
  readAgentMetadata,
} from "@cerebro/db/repositories/agents";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import {
  deleteSkill as deleteSkillRecord,
  listSkills as listSkillRecords,
  putSkill as putSkillRecord,
} from "@cerebro/db/repositories/skills";
import type { SkillRecord } from "@cerebro/db/repositories/skills";
import { channelEffect, installationSetup } from "@cerebro/db/schema/agents";
import { organization } from "@cerebro/db/schema/core";
import {
  identityGrant,
  identityPolicyRevision,
  identityPrincipal,
} from "@cerebro/db/schema/identity";
import { and, eq, sql } from "drizzle-orm";

import { createConversationService } from "./conversations";
import {
  authorize,
  contextByPrincipal,
  digest,
  trustedSetupCredential,
  principalContext,
  unwrap,
} from "./security";
import {
  ChannelError,
  EFFECT_DEADLINE_MS,
  INSTALLATION_AGENT_PREFIX,
} from "./types";
import type { AccessAction, ChannelOptions, ConnectorInput } from "./types";

export interface AgentInput {
  readonly operationId: string;
  readonly name: string;
  readonly instructions: string;
  readonly model: string;
  readonly enabledToolIds: readonly string[];
  readonly grants: readonly AgentGrant[];
  readonly expectedVersion?: number;
}
export const createChannelService = (
  database: Database,
  options: ChannelOptions
) => {
  const now = options.now ?? Date.now;
  const readOptions = () => ({ deadlineAt: now() + EFFECT_DEADLINE_MS });
  const current = (userId: string) =>
    principalContext(database, options.organizationId, userId);
  // Connectors and skills need the installation-wide manage grant, the same
  // grant that creates agents.
  const installationAdmin = async (userId: string): Promise<string> => {
    const context = await current(userId);
    await authorize(
      database,
      options,
      context,
      "manage",
      "agent",
      `${INSTALLATION_AGENT_PREFIX}${options.organizationId}`
    );
    return context.actor.id;
  };
  const connectorAdmin = async (userId: string) => {
    if (!options.connectors) {
      throw new ChannelError(
        503,
        "provider-unavailable",
        "Connectors are not configured."
      );
    }
    return {
      admin: options.connectors,
      principalId: await installationAdmin(userId),
    };
  };
  const canAdminister = async (userId: string): Promise<boolean> => {
    try {
      await installationAdmin(userId);
      return true;
    } catch (error) {
      if (error instanceof ChannelError) {
        return false;
      }
      throw error;
    }
  };
  const listConnectors = async (userId: string) => {
    const { admin } = await connectorAdmin(userId);
    return { connectors: await admin.list(database, options.organizationId) };
  };
  const addConnector = async (userId: string, input: ConnectorInput) => {
    const { admin, principalId } = await connectorAdmin(userId);
    return await admin.add(
      database,
      options.organizationId,
      principalId,
      input
    );
  };
  const refreshConnector = async (userId: string, connectorId: string) => {
    const { admin, principalId } = await connectorAdmin(userId);
    return await admin.refresh(
      database,
      options.organizationId,
      principalId,
      connectorId
    );
  };
  const removeConnector = async (userId: string, connectorId: string) => {
    const { admin } = await connectorAdmin(userId);
    await admin.remove(database, options.organizationId, connectorId);
    return { id: connectorId, removed: true };
  };
  const listSkills = async (userId: string) => {
    await installationAdmin(userId);
    return { skills: await listSkillRecords(database, options.organizationId) };
  };
  const putSkill = async (userId: string, input: SkillRecord) => {
    const principalId = await installationAdmin(userId);
    await putSkillRecord(database, {
      ...input,
      organizationId: options.organizationId,
      principalId,
    });
    return { name: input.name, saved: true };
  };
  const deleteSkill = async (userId: string, name: string) => {
    await installationAdmin(userId);
    if (!(await deleteSkillRecord(database, options.organizationId, name))) {
      throw new ChannelError(404, "not-found", "The skill was not found.");
    }
    return { name, removed: true };
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
      bootstrapTokenRequired: Boolean(options.bootstrapToken),
      canAdminister: await canAdminister(userId),
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
      if (!(await trustedSetupCredential(options, userId, bootstrapToken))) {
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
      await tx.insert(identityGrant).values(
        (
          [
            [
              "manage",
              "agent",
              `${INSTALLATION_AGENT_PREFIX}${options.organizationId}`,
            ],
            ["read", "audit", options.organizationId],
          ] as const
        ).map(([action, resourceKind, resourceId]) => ({
          action,
          organizationId: options.organizationId,
          principalId,
          resourceId,
          resourceKind,
          source: "installation-owner",
        }))
      );
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
        if (prior.digest !== requestDigest) {
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
  return {
    ...createConversationService(database, options),
    addConnector,
    catalog,
    deleteSkill,
    getAgent,
    install,
    listAgents,
    listConnectors,
    listSkills,
    publishAgent,
    putSkill,
    refreshConnector,
    removeConnector,
    setAccess,
    setup,
  };
};
export type ChannelService = ReturnType<typeof createChannelService>;
