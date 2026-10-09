import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf-8", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed with exit ${result.status}. ${result.stderr ?? ""}`,
      { cause: result.error }
    );
  }
  return result.stdout?.trim() ?? "";
};
let databaseUrl = process.env.CHANNEL_TEST_DATABASE_URL;
const container = `cerebro-channel-test-${randomUUID()}`;
let created = false;
try {
  if (!databaseUrl) {
    const password = randomUUID();
    run("docker", [
      "run",
      "--name",
      container,
      "--detach",
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_USER=cerebro",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "--env",
      "POSTGRES_DB=cerebro",
      "pgvector/pgvector:0.8.2-pg17-bookworm@sha256:feb68f4f15446397d8cac7f4fe48fe4586de83160d1fc48b46283312d1a33966",
    ]);
    created = true;
    const address = run("docker", ["port", container, "5432/tcp"]);
    databaseUrl = `postgres://cerebro:${password}@${address}/cerebro`;
    const waitForDatabase = async (attempts) => {
      const probe = spawnSync(
        "docker",
        [
          "exec",
          container,
          "pg_isready",
          "--host",
          "127.0.0.1",
          "--username",
          "cerebro",
          "--dbname",
          "cerebro",
        ],
        { stdio: "ignore" }
      );
      if (probe.status === 0) {
        return;
      }
      if (attempts === 0) {
        throw new Error("The isolated channel database did not become ready.");
      }
      await delay(500);
      await waitForDatabase(attempts - 1);
    };
    await waitForDatabase(60);
  }
  const client = postgres(databaseUrl, {
    max: 1,
    onnotice: () => null,
    prepare: false,
  });
  try {
    await migrate(drizzle(client), {
      migrationsFolder: new URL(
        "../../packages/db/src/migrations",
        import.meta.url
      ).pathname,
    });
  } finally {
    await client.end({ timeout: 2 });
  }
  const result = spawnSync(
    "bun",
    [
      "test",
      "--timeout",
      "30000",
      "tests/channels/web.test.ts",
      "tests/channels/production.test.ts",
      "tests/channels/slack.test.ts",
      "tests/channels/ui.test.ts",
      "tests/channels/conversation.test.ts",
      "tests/channels/observation.test.ts",
    ],
    {
      env: { ...process.env, CHANNEL_TEST_DATABASE_URL: databaseUrl },
      stdio: "inherit",
    }
  );
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
} finally {
  if (created) {
    run("docker", ["rm", "--force", container]);
  }
}
