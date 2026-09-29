import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const base = process.env.BASE_URL ?? "http://localhost:18765";
const project = process.env.COMPOSE_PROJECT_NAME ?? "cerebro-slice";
const commands = [];
const compose = (...args) => {
  execFileSync(
    "rtk",
    [
      "proxy",
      "docker",
      "compose",
      "-p",
      project,
      "-f",
      "experiments/celld-slice/compose.yaml",
      ...args,
    ],
    {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 120_000,
    }
  );
  commands.push({ args, exit: 0 });
};
const request = async (path, method = "GET") => {
  const response = await fetch(base + path, {
    method,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { nonJson: true };
  }
  return { body, status: response.status };
};
const results = [];
try {
  const before = await request("/database");
  assert.equal(before.status, 200);
  let unavailable;
  compose("stop", "postgres");
  try {
    unavailable = await request(
      `/database/read?key=${before.body.committedKey}`
    );
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.retryable, true);
  } finally {
    compose("up", "-d", "--no-deps", "--wait", "postgres");
  }
  const after = await request(`/database/read?key=${before.body.committedKey}`);
  assert.equal(after.status, 200);
  assert.equal(after.body.row.value, before.body.value);
  results.push({
    after,
    before,
    id: "recovery.postgres-outage",
    status: "pass",
    unavailable,
  });
  const conversation = crypto.randomUUID();
  const oldId = crypto.randomUUID();
  const nextId = crypto.randomUUID();
  const prefix = `/sessions/${conversation}/durability?id=`;
  const durable = await request(prefix + oldId, "POST");
  assert.equal(durable.status, 200);
  let unavailableStorage;
  compose("stop", "minio-runtime");
  try {
    unavailableStorage = await request(prefix + nextId, "POST");
    assert.equal(unavailableStorage.status, 503);
    assert.equal(unavailableStorage.body.retryable, true);
    assert.equal(unavailableStorage.body.outcome, "unknown");
  } finally {
    compose("up", "-d", "--no-deps", "--wait", "minio-runtime");
  }
  const preserved = await request(prefix + oldId);
  assert.equal(preserved.status, 200);
  assert.equal(preserved.body.value, "durable-marker");
  const retried = await request(prefix + nextId, "POST");
  assert.equal(retried.status, 200);
  assert.equal(retried.body.value, "durable-marker");
  results.push({
    durable,
    id: "recovery.minio-outage",
    preserved,
    retried,
    status: "pass",
    unavailableStorage,
  });
} catch (error) {
  results.push({ error: error.message, id: "outage-suite", status: "fail" });
  process.exitCode = 1;
} finally {
  await mkdir(new URL("../results/", import.meta.url), { recursive: true });
  await writeFile(
    new URL("../results/outage-evidence.json", import.meta.url),
    `${JSON.stringify({ commands, results, timestamp: new Date().toISOString() }, null, 2)}\n`
  );
}
process.stdout.write(
  `${JSON.stringify(
    results.map(({ id, status, error }) => ({ error, id, status })),
    null,
    2
  )}\n`
);
