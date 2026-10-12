import { and, eq } from "drizzle-orm";

import type { Database } from "../index.ts";
import { connectorAccount } from "../schema/accounts.ts";

export const findSealedAccount = async (
  database: Database,
  organizationId: string,
  accountId: string
): Promise<string | undefined> => {
  const [record] = await database
    .select({ sealed: connectorAccount.sealed })
    .from(connectorAccount)
    .where(
      and(
        eq(connectorAccount.organizationId, organizationId),
        eq(connectorAccount.id, accountId)
      )
    );
  return record?.sealed;
};
