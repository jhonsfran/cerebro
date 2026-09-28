import { createAuth as createConfiguredAuth } from "@cerebro/auth";
import { type Database, createDb } from "@cerebro/db";

import { ENV } from "./env.server";

export function getDb(): Database {
  return createDb(ENV);
}
export async function createAuth(database?: Database) {
  return createConfiguredAuth(ENV, database ?? (await getDb()));
}
