import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

let password;
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf-8", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed with exit ${result.status}. ${(result.stderr ?? "").replaceAll(password ?? "unused-password", "[REDACTED]")}`,
      { cause: result.error }
    );
  }
  return result.stdout?.trim() ?? "";
};
let databaseUrl = process.env.CHANNEL_TEST_DATABASE_URL;
const runId = randomUUID();
const name = `cerebro-channel-test-${runId}`;
let container;
const inspectOwned = () => {
  assert.match(container, /^[a-f0-9]{64}$/u);
  const value = JSON.parse(
    run("docker", [
      "inspect",
      "--format",
      '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}}}',
      container,
    ])
  );
  assert.equal(value.id, container);
  assert.equal(value.labels["cerebro.test-run"], runId);
  assert.equal(value.labels["cerebro.slice-1"], "disposable");
  return value;
};
try {
  if (!databaseUrl) {
    password = randomUUID();
    container = run(
      "docker",
      [
        "run",
        "--name",
        name,
        "--detach",
        "--label",
        "cerebro.slice-1=disposable",
        "--label",
        `cerebro.test-run=${runId}`,
        "--publish",
        "127.0.0.1::5432",
        "--tmpfs",
        "/var/lib/postgresql/data:rw",
        "--env",
        "POSTGRES_USER=cerebro",
        "--env",
        "POSTGRES_PASSWORD",
        "--env",
        "POSTGRES_DB=cerebro",
        "pgvector/pgvector:0.8.2-pg17-bookworm@sha256:feb68f4f15446397d8cac7f4fe48fe4586de83160d1fc48b46283312d1a33966",
      ],
      { env: { ...process.env, POSTGRES_PASSWORD: password } }
    );
    const metadata = inspectOwned();
    assert.ok(metadata.tmpfs?.["/var/lib/postgresql/data"]);
    assert.equal(
      metadata.mounts.some((mount) => mount.Type === "volume"),
      false
    );
    process.stdout.write(
      `${JSON.stringify({ channelDatabase: "owned", runId, container, mounts: metadata.mounts.map(({ Type, Destination }) => ({ Type, Destination })), volumesCreated: 0 })}\n`
    );
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
      "tests/channels/primary-conversations.test.ts",
      "tests/channels/production.test.ts",
      "tests/channels/slack.test.ts",
      "tests/channels/slack-events.test.ts",
      "tests/channels/team-events.test.ts",
      "tests/channels/team-reports.test.ts",
      "tests/channels/coordinator-policy.test.ts",
      "tests/channels/ui.test.ts",
      "tests/channels/conversation.test.ts",
      "tests/channels/conversation-bootstrap-ui.test.ts",
      "tests/channels/delivery.test.ts",
      "tests/channels/observation.test.ts",
      "tests/channels/capabilities-ui.test.ts",
      "tests/channels/inspection-ui.test.ts",
      "tests/channels/inspection-refresh-ui.test.ts",
      "tests/channels/forks.test.ts",
      "tests/channels/inspection-proof.test.ts",
      "tests/channels/inspection.test.ts",
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
  if (container) {
    const metadata = inspectOwned();
    const volumes = metadata.mounts
      .filter((mount) => mount.Type === "volume")
      .map((mount) => mount.Name);
    run("docker", ["rm", "--force", "--volumes", container]);
    assert.equal(
      run("docker", [
        "ps",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `id=${container}`,
      ]),
      ""
    );
    assert.equal(
      run("docker", [
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `label=cerebro.test-run=${runId}`,
      ]),
      ""
    );
    for (const volume of volumes) {
      const remaining = run("docker", [
        "volume",
        "ls",
        "--quiet",
        "--filter",
        `name=${volume}`,
      ]).split("\n");
      assert.equal(remaining.includes(volume), false);
    }
    process.stdout.write(
      `${JSON.stringify({ channelDatabase: "removed", runId, container, capturedVolumes: volumes, remainingContainers: 0, remainingCapturedVolumes: 0 })}\n`
    );
  }
}
