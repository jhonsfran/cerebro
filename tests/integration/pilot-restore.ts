/* oxlint-disable no-await-in-loop -- Restore checks compare each store after the previous mutation has completed. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const dataTables = [
  "usage_account",
  "usage_reservation",
  "usage_operation",
  "cerebro_audit_event",
  "channel_item",
  "memory_source",
  "memory_record",
  "memory_artifact",
];
const freePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.close();
  await once(server, "close");
  return address.port;
};
const observations = async (port: string | number) => {
  const response = await fetch(`http://localhost:${port}/observations`, {
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200);
  return await response.json();
};

interface RestoreInput {
  readonly project: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly cookie: string;
  readonly conversationId: string;
  readonly sourceId: string;
  readonly sourceText: string;
  readonly eventId: string;
  readonly eventText: string;
}
export const verifyPilotRestore = async (input: RestoreInput) => {
  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "cerebro-pilot-snapshot-")
  );
  const directory = path.join(tempDirectory, "snapshot");
  const target = `cerebro-restored-${randomBytes(5).toString("hex")}`;
  const [apiPort, webPort, fixturePort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
  ]);
  const restoredApi = `http://localhost:${apiPort}`;
  const restoreEnvironment = {
    ...input.environment,
    CEREBRO_API_PORT: String(apiPort),
    CEREBRO_FIXTURE_PORT: String(fixturePort),
    CEREBRO_WEB_PORT: String(webPort),
  };
  const compose = async (project: string, ...args: string[]) =>
    await execute("docker", ["compose", "-p", project, ...args], {
      cwd: root,
      env: project === target ? restoreEnvironment : input.environment,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 10 * 60_000,
    });
  const fingerprints = async (project: string) => {
    const rows: Record<string, string> = {};
    for (const table of dataTables) {
      const result = await compose(
        project,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "cerebro",
        "-d",
        "cerebro",
        "-tA",
        "-c",
        `SELECT count(*) || ':' || md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) FROM ${table} t`
      );
      rows[table] = result.stdout.trim();
    }
    return rows;
  };
  const request = async (apiUrl: string, route: string, body?: unknown) => {
    const response = await fetch(`${apiUrl}${route}`, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        "Content-Type": "application/json",
        Cookie: input.cookie,
        Origin: input.webUrl,
      },
      method: body === undefined ? "GET" : "POST",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    assert.equal(response.status, 200, `Restored ${route}: ${text}`);
    return JSON.parse(text) as unknown;
  };
  const conversationPath = `/api/product/conversations/${encodeURIComponent(input.conversationId)}`;
  let pendingProjections = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await request(input.apiUrl, conversationPath);
    const pending = await compose(
      input.project,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "cerebro",
      "-d",
      "cerebro",
      "-tA",
      "-c",
      "SELECT count(*) FROM channel_conversation WHERE projection_state <> 'idle'"
    );
    pendingProjections = pending.stdout.trim();
    if (pendingProjections === "0") {
      break;
    }
    await delay(1000);
  }
  assert.equal(
    pendingProjections,
    "0",
    "Source projections must settle before backup."
  );
  const previous = await request(input.apiUrl, conversationPath);
  const before = await fingerprints(input.project);
  for (let sample = 0; sample < 3; sample += 1) {
    await delay(1200);
    assert.deepEqual(await fingerprints(input.project), before);
  }
  assert.ok(input.environment.CEREBRO_FIXTURE_PORT);
  const providerBefore = await observations(
    input.environment.CEREBRO_FIXTURE_PORT
  );
  let passed = false;
  const started = performance.now();
  try {
    await execute(
      process.execPath,
      [
        "deploy/backup.mjs",
        "backup",
        "--project",
        input.project,
        "--directory",
        directory,
      ],
      {
        cwd: root,
        env: input.environment,
        maxBuffer: 1024 * 1024,
        timeout: 10 * 60_000,
      }
    );
    await execute(
      process.execPath,
      [
        "deploy/backup.mjs",
        "restore",
        "--project",
        target,
        "--directory",
        directory,
      ],
      {
        cwd: root,
        env: restoreEnvironment,
        maxBuffer: 1024 * 1024,
        timeout: 10 * 60_000,
      }
    );
    const override = path.join(directory, `${target}.images.yaml`);
    await compose(
      target,
      "-f",
      "compose.yaml",
      "-f",
      override,
      "up",
      "-d",
      "--wait",
      "--no-build"
    );
    const readiness = await fetch(`${restoredApi}/ready`, {
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(readiness.status, 200);
    assert.deepEqual(await fingerprints(target), before);
    const auth = await request(restoredApi, "/api/auth/get-session");
    assert.ok(auth && typeof auth === "object" && "user" in auth && auth.user);
    assert.deepEqual(await request(restoredApi, conversationPath), previous);
    const source = await request(
      restoredApi,
      `${conversationPath}/sources/${encodeURIComponent(input.sourceId)}`
    );
    assert.ok(source && typeof source === "object" && "text" in source);
    assert.equal(source.text, input.sourceText);
    const replay = await request(restoredApi, `${conversationPath}/messages`, {
      eventId: input.eventId,
      text: input.eventText,
    });
    assert.ok(replay && typeof replay === "object" && "receipt" in replay);
    const { receipt } = replay;
    assert.ok(receipt && typeof receipt === "object" && "replayed" in receipt);
    assert.equal(receipt.replayed, true);
    for (let sample = 0; sample < 3; sample += 1) {
      await delay(1200);
      assert.deepEqual(await request(restoredApi, conversationPath), previous);
      assert.deepEqual(await fingerprints(target), before);
      assert.deepEqual(await observations(fixturePort), providerBefore);
    }
    passed = true;
    return {
      elapsedMs: Math.round(performance.now() - started),
      restoredTables: dataTables,
      restoredVolumes: 7,
      target,
    };
  } finally {
    if (passed) {
      await compose(target, "down", "--volumes");
      await rm(tempDirectory, { recursive: true });
    } else {
      process.stdout.write(
        `Restore evidence retained: project ${target}, private snapshot ${directory}.\n`
      );
    }
  }
};
