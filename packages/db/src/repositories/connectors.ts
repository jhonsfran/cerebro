import { and, eq } from "drizzle-orm";

import type { Database } from "../index.ts";
import { connector } from "../schema/connectors.ts";

export const createConnectorRepository = (database: Database) => ({
  async findActive(organizationId: string, connectorId: string) {
    const [record] = await database
      .select()
      .from(connector)
      .where(
        and(
          eq(connector.organizationId, organizationId),
          eq(connector.id, connectorId),
          eq(connector.state, "active")
        )
      );
    return record;
  },
});
