import { id, preflightEffect } from "@cerebro/contracts";
import type {
  AgentDefinition,
  AgentRepository,
  EffectOptions,
  PortResult,
} from "@cerebro/contracts";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../index";
import { agent, agentPublishOperation, agentVersion } from "../schema/agents";
import { identityGrant, identityPolicyRevision } from "../schema/identity";

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)])
    );
  }
  return value;
};

export const publishAgentConfiguration = async (
  database: Database,
  definition: AgentDefinition,
  expectedVersion: number | undefined,
  options: EffectOptions,
  metadata?: { readonly name: string; readonly creatorPrincipalId?: string }
): Promise<PortResult<AgentDefinition>> => {
  const preflight = preflightEffect(options, Date.now());
  if (preflight.status !== "ok") {
    return preflight;
  }
  if (
    !Number.isSafeInteger(definition.version) ||
    definition.version !== (expectedVersion ?? 0) + 1
  ) {
    return {
      reason: "The agent version must be the next positive integer.",
      status: "invalid-input",
    };
  }
  return await database.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${definition.organizationId}), hashtext(${options.operationId}))`
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${definition.organizationId}), hashtext(${definition.agentId}))`
    );
    const [prior] = await tx
      .select()
      .from(agentPublishOperation)
      .where(
        and(
          eq(agentPublishOperation.organizationId, definition.organizationId),
          eq(agentPublishOperation.operationId, options.operationId)
        )
      );
    if (prior) {
      return prior.digest === options.requestDigest &&
        JSON.stringify(canonical(prior.definition)) ===
          JSON.stringify(canonical(definition))
        ? { status: "ok", value: prior.definition }
        : {
            code: "digest-mismatch",
            reason: "The publish operation already has different content.",
            status: "conflict",
          };
    }
    const [current] = await tx
      .select()
      .from(agent)
      .where(
        and(
          eq(agent.organizationId, definition.organizationId),
          eq(agent.agentId, definition.agentId)
        )
      );
    if (current?.currentVersion !== expectedVersion) {
      return {
        code: "version-mismatch",
        reason: "The current agent version changed.",
        status: "conflict",
      };
    }
    await tx.insert(agentVersion).values({
      agentId: definition.agentId,
      definition,
      organizationId: definition.organizationId,
      version: definition.version,
    });
    await tx
      .insert(agent)
      .values({
        agentId: definition.agentId,
        currentVersion: definition.version,
        name: metadata?.name ?? definition.agentId,
        organizationId: definition.organizationId,
      })
      .onConflictDoUpdate({
        set: {
          currentVersion: definition.version,
          ...(metadata ? { name: metadata.name } : {}),
        },
        target: [agent.organizationId, agent.agentId],
      });
    await tx.insert(agentPublishOperation).values({
      definition,
      digest: options.requestDigest,
      operationId: options.operationId,
      organizationId: definition.organizationId,
    });
    if (metadata?.creatorPrincipalId && expectedVersion === undefined) {
      await tx
        .insert(identityGrant)
        .values(
          (["read", "execute", "approve", "manage"] as const).map((action) => ({
            action,
            organizationId: definition.organizationId,
            principalId: metadata.creatorPrincipalId ?? "",
            resourceId: definition.agentId,
            resourceKind: "agent" as const,
            source: "manual",
          }))
        )
        .onConflictDoNothing();
      await tx
        .insert(identityPolicyRevision)
        .values({ organizationId: definition.organizationId, version: 1 })
        .onConflictDoUpdate({
          set: { version: sql`${identityPolicyRevision.version} + 1` },
          target: identityPolicyRevision.organizationId,
        });
    }
    return { status: "ok", value: definition };
  });
};

export const createAgentRepository = (database: Database): AgentRepository => ({
  async get(organizationId, agentId, version, options) {
    if (options.signal?.aborted || options.deadlineAt <= Date.now()) {
      return {
        code: options.signal?.aborted ? "cancelled" : "deadline-exceeded",
        reason: "The agent read was interrupted.",
        status: "unavailable",
      };
    }
    const [metadata] = await database
      .select()
      .from(agent)
      .where(
        and(
          eq(agent.organizationId, organizationId),
          eq(agent.agentId, agentId)
        )
      );
    if (!metadata) {
      return { resource: "agent", status: "not-found" };
    }
    const [row] = await database
      .select()
      .from(agentVersion)
      .where(
        and(
          eq(agentVersion.organizationId, organizationId),
          eq(agentVersion.agentId, agentId),
          eq(
            agentVersion.version,
            version === "latest" ? metadata.currentVersion : version
          )
        )
      );
    return row
      ? { status: "ok", value: row.definition }
      : { resource: "agent version", status: "not-found" };
  },
  publish: (definition, expectedVersion, options) =>
    publishAgentConfiguration(database, definition, expectedVersion, options),
});

export const listAgentMetadata = (database: Database, organizationId: string) =>
  database.select().from(agent).where(eq(agent.organizationId, organizationId));
export const readAgentMetadata = async (
  database: Database,
  organizationId: string,
  agentId: string
) => {
  const [row] = await database
    .select()
    .from(agent)
    .where(
      and(eq(agent.organizationId, organizationId), eq(agent.agentId, agentId))
    );
  return row;
};
export const agentDefinitionAddress = (
  organizationId: string,
  agentId: string
) => ({
  agentId: id.agent(agentId),
  organizationId: id.organization(organizationId),
});
