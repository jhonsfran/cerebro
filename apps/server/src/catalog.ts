import type { Database } from "@cerebro/db";
import { listConnectorTools } from "@cerebro/db/repositories/catalog";

import { parseCatalogTool } from "./config";
import type { CatalogTool } from "./config";

export const catalogTools = async (
  database: Database,
  organizationId: string
): Promise<readonly CatalogTool[]> => {
  const definitions = await listConnectorTools(database, organizationId);
  return definitions.map(parseCatalogTool);
};
