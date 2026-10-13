import type { Database } from "@cerebro/db";
import { listConnectorTools } from "@cerebro/db/repositories/catalog";

import type { CatalogTool } from "./config";
import { parseCatalogTool } from "./config";

export const catalogTools = async (
  database: Database,
  organizationId: string
): Promise<readonly CatalogTool[]> => {
  const definitions = await listConnectorTools(database, organizationId);
  return definitions.map(parseCatalogTool);
};
