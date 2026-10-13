import { and, eq, like, notInArray, sql } from "drizzle-orm";

import type { Database } from "../index.ts";
import { connectorAccount } from "../schema/accounts.ts";
import { connector, connectorTool } from "../schema/connectors.ts";
import { identityGrant, identityPolicyRevision } from "../schema/identity.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Source = (typeof connectorTool.$inferInsert)["source"];
export interface CatalogRow {
  readonly id: string;
  readonly connectorId: string;
  readonly definition: unknown;
}
export interface ConnectorSummary {
  readonly id: string;
  readonly source: "admin" | "runtime.json";
  readonly toolCount: number;
  readonly url: string | null;
}

export const listConnectorTools = async (
  database: Database,
  organizationId: string
): Promise<readonly unknown[]> => {
  const rows = await database
    .select({ definition: connectorTool.definition })
    .from(connectorTool)
    .where(eq(connectorTool.organizationId, organizationId))
    .orderBy(connectorTool.id);
  return rows.map((row) => row.definition);
};

export const findConnectorTool = async (
  database: Database,
  organizationId: string,
  toolId: string
): Promise<unknown | undefined> => {
  const [row] = await database
    .select({ definition: connectorTool.definition })
    .from(connectorTool)
    .where(
      and(
        eq(connectorTool.organizationId, organizationId),
        eq(connectorTool.id, toolId)
      )
    )
    .limit(1);
  return row?.definition;
};

// Each source owns its rows: replacing a source never touches another's tools.
export const replaceSourceTools = async (
  database: Database | Transaction,
  organizationId: string,
  source: Source,
  tools: readonly CatalogRow[]
): Promise<void> => {
  await database
    .delete(connectorTool)
    .where(
      and(
        eq(connectorTool.organizationId, organizationId),
        eq(connectorTool.source, source)
      )
    );
  if (tools.length > 0) {
    await database
      .insert(connectorTool)
      .values(tools.map((tool) => ({ ...tool, organizationId, source })));
  }
};

// Removes the tools of sources under `prefix` that are no longer configured.
export const removeStaleSources = async (
  database: Database | Transaction,
  organizationId: string,
  prefix: string,
  keep: readonly Source[]
): Promise<void> => {
  await database
    .delete(connectorTool)
    .where(
      and(
        eq(connectorTool.organizationId, organizationId),
        like(connectorTool.source, `${prefix}%`),
        keep.length > 0
          ? notInArray(connectorTool.source, [...keep])
          : undefined
      )
    );
};

export const listConnectors = async (
  database: Database,
  organizationId: string
): Promise<readonly ConnectorSummary[]> => {
  const counts = await database
    .select({
      connectorId: connectorTool.connectorId,
      source: connectorTool.source,
      toolCount: sql<number>`count(*)::int`,
    })
    .from(connectorTool)
    .where(eq(connectorTool.organizationId, organizationId))
    .groupBy(connectorTool.connectorId, connectorTool.source);
  const added = await database
    .select({ id: connector.id, url: connector.url })
    .from(connector)
    .where(eq(connector.organizationId, organizationId));
  const declared = new Map<string, number>();
  for (const row of counts) {
    if (!row.source.startsWith("admin:")) {
      declared.set(
        row.connectorId,
        (declared.get(row.connectorId) ?? 0) + row.toolCount
      );
    }
  }
  return [
    ...added.map((row) => ({
      id: row.id,
      source: "admin" as const,
      toolCount:
        counts.find((count) => count.source === `admin:${row.id}`)?.toolCount ??
        0,
      url: row.url,
    })),
    ...[...declared].map(([id, toolCount]) => ({
      id,
      source: "runtime.json" as const,
      toolCount,
      url: null,
    })),
  ].toSorted((first, second) => first.id.localeCompare(second.id));
};

export const findConnector = async (
  database: Database,
  organizationId: string,
  connectorId: string
): Promise<{ readonly url: string } | undefined> => {
  const [row] = await database
    .select({ url: connector.url })
    .from(connector)
    .where(
      and(
        eq(connector.organizationId, organizationId),
        eq(connector.id, connectorId)
      )
    );
  return row;
};

const bumpPolicyRevision = (tx: Transaction, organizationId: string) =>
  tx
    .insert(identityPolicyRevision)
    .values({ organizationId, version: 1 })
    .onConflictDoUpdate({
      set: { version: sql`${identityPolicyRevision.version} + 1` },
      target: identityPolicyRevision.organizationId,
    });

// Saves a connector, its credentials when given, and its tools. The principal
// who saved it can read and execute its tools, so they can enable them.
export const saveAdminConnector = (
  database: Database,
  input: {
    readonly organizationId: string;
    readonly id: string;
    readonly url: string;
    readonly principalId: string;
    readonly account?: { readonly id: string; readonly sealed: string };
    readonly tools: readonly CatalogRow[];
  }
): Promise<void> =>
  database.transaction(async (tx) => {
    const { organizationId } = input;
    await tx
      .insert(connector)
      .values({
        createdBy: input.principalId,
        id: input.id,
        organizationId,
        url: input.url,
      })
      .onConflictDoUpdate({
        set: { url: input.url },
        target: [connector.organizationId, connector.id],
      });
    if (input.account) {
      await tx
        .insert(connectorAccount)
        .values({
          id: input.account.id,
          label: input.id,
          organizationId,
          sealed: input.account.sealed,
        })
        .onConflictDoUpdate({
          set: { sealed: input.account.sealed, updatedAt: sql`now()` },
          target: [connectorAccount.organizationId, connectorAccount.id],
        });
    }
    await replaceSourceTools(
      tx,
      organizationId,
      `admin:${input.id}`,
      input.tools
    );
    const grantSource = `connector:${input.id}`;
    await tx
      .insert(identityGrant)
      .values([
        ...input.tools.flatMap((tool) =>
          (["read", "execute"] as const).map((action) => ({
            action,
            organizationId,
            principalId: input.principalId,
            resourceId: tool.id,
            resourceKind: "tool" as const,
            source: grantSource,
          }))
        ),
        {
          action: "execute" as const,
          organizationId,
          principalId: input.principalId,
          resourceId: input.id,
          resourceKind: "tool" as const,
          source: grantSource,
        },
      ])
      .onConflictDoNothing();
    await bumpPolicyRevision(tx, organizationId);
  });

export const deleteAdminConnector = (
  database: Database,
  organizationId: string,
  connectorId: string,
  accountId: string
): Promise<void> =>
  database.transaction(async (tx) => {
    await replaceSourceTools(tx, organizationId, `admin:${connectorId}`, []);
    await tx
      .delete(identityGrant)
      .where(
        and(
          eq(identityGrant.organizationId, organizationId),
          eq(identityGrant.source, `connector:${connectorId}`)
        )
      );
    await tx
      .delete(connectorAccount)
      .where(
        and(
          eq(connectorAccount.organizationId, organizationId),
          eq(connectorAccount.id, accountId)
        )
      );
    await tx
      .delete(connector)
      .where(
        and(
          eq(connector.organizationId, organizationId),
          eq(connector.id, connectorId)
        )
      );
    await bumpPolicyRevision(tx, organizationId);
  });
