import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const docker = (args) => {
  const result = spawnSync("docker", args, {
    cwd: root,
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Docker command failed.");
  }
  return result.stdout.trim();
};
const waitForPostgres = async (container, deadline) => {
  const ready = spawnSync(
    "docker",
    [
      "exec",
      container,
      "pg_isready",
      "--host",
      "127.0.0.1",
      "-U",
      "policy_fixture",
      "-d",
      "policy_fixture",
    ],
    { encoding: "utf-8", timeout: 5000 }
  );
  if (ready.status === 0) {
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error("Policy fixture PostgreSQL did not become ready.");
  }
  await delay(200);
  await waitForPostgres(container, deadline);
};
const files = ["agent-authority.test.ts", "tool-boundary.test.ts"];
let ownedContainer;
let databaseUrl = process.env.POLICY_TEST_DATABASE_URL;
try {
  if (!databaseUrl) {
    ownedContainer = `cerebro-policy-test-${randomUUID()}`;
    docker([
      "run",
      "--detach",
      "--name",
      ownedContainer,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_USER=policy_fixture",
      "--env",
      "POSTGRES_PASSWORD=policy-local-fixture",
      "--env",
      "POSTGRES_DB=policy_fixture",
      "pgvector/pgvector:0.8.2-pg17-bookworm@sha256:feb68f4f15446397d8cac7f4fe48fe4586de83160d1fc48b46283312d1a33966",
    ]);
    await waitForPostgres(ownedContainer, Date.now() + 60_000);
    const binding = docker(["port", ownedContainer, "5432/tcp"]);
    const port = binding.split(":").at(-1);
    if (!port || !/^\d+$/u.test(port)) {
      throw new Error("Docker did not assign a PostgreSQL port.");
    }
    databaseUrl = `postgres://policy_fixture:policy-local-fixture@127.0.0.1:${port}/policy_fixture`;
    const require = createRequire(
      new URL("../../packages/db/package.json", import.meta.url)
    );
    const { default: postgres } = await import(require.resolve("postgres"));
    const { drizzle } = await import(
      require.resolve("drizzle-orm/postgres-js")
    );
    const { migrate } = await import(
      require.resolve("drizzle-orm/postgres-js/migrator")
    );
    const client = postgres(databaseUrl, { max: 1 });
    try {
      await migrate(drizzle(client), {
        migrationsFolder: `${root}/packages/db/src/migrations`,
      });
    } finally {
      await client.end({ timeout: 2 });
    }
  }
  const result = spawnSync(
    process.execPath,
    ["--test", ...files.map((name) => `tests/policy/${name}`)],
    {
      cwd: root,
      env: { ...process.env, POLICY_TEST_DATABASE_URL: databaseUrl },
      stdio: "inherit",
    }
  );
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
} finally {
  if (ownedContainer) {
    docker(["rm", "--force", ownedContainer]);
  }
}
