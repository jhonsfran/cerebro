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
      "postgres:17.9-bookworm@sha256:47f917f7409eacd22fc5dfb1dee634e1b55cf0c01d1a7eb701be2227a03e0641",
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
      "tests/channels/web.test.ts",
      "tests/channels/slack.test.ts",
      "tests/channels/ui.test.ts",
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
