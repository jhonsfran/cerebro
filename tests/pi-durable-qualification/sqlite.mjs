/* oxlint-disable require-await, promise/prefer-await-to-callbacks -- Pi requires an async SQL facade and an async transaction callback over synchronous DO statements. */
import {
  SQLITE_MIGRATIONS,
  SqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite";

const binding = (value) => {
  if (value instanceof Uint8Array) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength
    );
  }
  if (typeof value === "bigint") {
    if (
      value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      throw new RangeError("SQLite integer outside safe range");
    }
    return Number(value);
  }
  return value;
};
const row = (value) =>
  Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      item instanceof ArrayBuffer ? new Uint8Array(item) : item,
    ])
  );
// Qualification-only facade. The production adapter remains S1-A work.
export const database = (storage) => {
  const names = new Set(["durable_schema"]);
  for (const migration of SQLITE_MIGRATIONS) {
    for (const statement of migration.statements) {
      for (const match of statement.matchAll(
        /\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?<name>[A-Za-z_][A-Za-z0-9_]*)/giu
      )) {
        names.add(match.groups.name);
      }
    }
  }
  const pattern = new RegExp(`\\b(?:${[...names].join("|")})\\b`, "gu");
  const rewrite = (sql) =>
    sql
      .split(/(?<literal>'(?:[^']|'')*')/u)
      .map((part, index) =>
        index % 2 === 1 ? part : part.replace(pattern, (name) => `pi_${name}`)
      )
      .join("");
  let tail = Promise.resolve();
  const queue = (operation) => {
    const prior = tail;
    const result = (async () => {
      await prior;
      return await operation();
    })();
    tail = (async () => {
      try {
        await result;
      } catch {
        // Failed operations do not block the queue.
      }
    })();
    return result;
  };
  const executor = () => ({
    all: async (sql, ...params) =>
      storage.sql
        .exec(rewrite(sql), ...params.map(binding))
        .toArray()
        .map(row),
    exec: async (sql) => {
      storage.sql.exec(rewrite(sql));
    },
    get: async (sql, ...params) => {
      const result = storage.sql
        .exec(rewrite(sql), ...params.map(binding))
        .next();
      return result.done ? undefined : row(result.value);
    },
    run: async (sql, ...params) => {
      storage.sql.exec(rewrite(sql), ...params.map(binding));
    },
  });
  return {
    all: (sql, ...params) => queue(() => executor().all(sql, ...params)),
    close: async () => {
      await tail;
    },
    exec: (sql) => queue(() => executor().exec(sql)),
    get: (sql, ...params) => queue(() => executor().get(sql, ...params)),
    run: (sql, ...params) => queue(() => executor().run(sql, ...params)),
    transaction: (callback) =>
      queue(() =>
        storage.transaction(async () => {
          let active = true;
          const statements = executor();
          const transaction = Object.fromEntries(
            Object.entries(statements).map(([name, method]) => [
              name,
              (...args) => {
                if (!active) {
                  throw new Error("Transaction has ended");
                }
                return method(...args);
              },
            ])
          );
          try {
            return await callback(transaction);
          } finally {
            active = false;
          }
        })
      ),
  };
};
export const openStorage = (storage) => SqliteStorage.open(database(storage));
