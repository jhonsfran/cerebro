import { and, eq } from "drizzle-orm";

import type { Database } from "../index.ts";
import { connectorTool } from "../schema/connectors.ts";

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

export const connectorToolExists = async (
  database: Database,
  organizationId: string,
  toolId: string
): Promise<boolean> => {
  const [row] = await database
    .select({ id: connectorTool.id })
    .from(connectorTool)
    .where(
      and(
        eq(connectorTool.organizationId, organizationId),
        eq(connectorTool.id, toolId)
      )
    )
    .limit(1);
  return row !== undefined;
};
