import { drizzle } from "drizzle-orm/durable-sqlite";

export const createDurableDb = (storage: DurableObjectStorage) =>
  drizzle(storage);

export type DurableDatabase = ReturnType<typeof createDurableDb>;
