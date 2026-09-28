import type { Session } from "@cerebro/auth";
import type { Database } from "@cerebro/db";

export type Context = {
  session: Session | null;
  db: Database;
};
