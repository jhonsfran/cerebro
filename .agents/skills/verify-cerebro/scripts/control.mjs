#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

const root = path.resolve(import.meta.dirname, "../../../..");
const executeFile = promisify(execFile);
const execute = (command, args, options = {}) =>
  executeFile("rtk", ["proxy", command, ...args], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
    ...options,
  });
const [command, runId] = process.argv.slice(2);
assert.ok(
  ["launch", "doctor", "token", "observe", "cleanup"].includes(command),
  "Use launch, doctor, token, observe, or cleanup followed by a run ID"
);
assert.match(runId ?? "", /^[a-z0-9][a-z0-9-]{0,39}$/u);
const directory = path.join(root, "artifacts/verification", runId);
const statePath = path.join(directory, "state.json");
const stateSchema = z.object({
  apiPort: z.number().int().min(1024).max(65_535),
  fixturePort: z.number().int().min(1024).max(65_535),
  project: z.string().regex(/^cerebro-s1-verify-[a-z0-9-]+$/u),
  sha: z.string().regex(/^[a-f0-9]{40}$/u),
  webPort: z.number().int().min(1024).max(65_535),
});
const readState = async () => {
  const state = stateSchema.parse(
    JSON.parse(await readFile(statePath, "utf-8"))
  );
  assert.equal(
    state.project,
    `cerebro-s1-verify-${runId}`,
    "State belongs to a different verification run"
  );
  return state;
};
const writeJson = (name, value) =>
  writeFile(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
const bootArgs = (state) => [
  "tests/slice-1/boot.mjs",
  "--project",
  state.project,
  "--state-sha",
  state.sha,
  "--api-port",
  String(state.apiPort),
  "--web-port",
  String(state.webPort),
  "--fixture-port",
  String(state.fixturePort),
];
const freePort = async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.close();
  await once(server, "close");
  assert.ok(address.port >= 1024);
  return address.port;
};
const ownedContainers = async (state) => {
  const listed = await execute("docker", [
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${state.project}`,
  ]);
  const ids = listed.stdout.trim().split("\n").filter(Boolean);
  if (ids.length === 0) {
    return [];
  }
  const inspected = await execute("docker", ["inspect", ...ids]);
  const containers = z
    .array(
      z.object({
        Config: z.object({ Labels: z.record(z.string(), z.string()) }),
        HostConfig: z.object({
          PortBindings: z
            .record(
              z.string(),
              z.array(z.object({ HostIp: z.string(), HostPort: z.string() }))
            )
            .nullable(),
        }),
        Id: z.string(),
        Image: z.string(),
        State: z.object({ Running: z.boolean() }),
      })
    )
    .parse(JSON.parse(inspected.stdout));
  for (const container of containers) {
    assert.equal(container.Config.Labels["cerebro.slice-1"], "disposable");
    assert.equal(
      container.Config.Labels["com.docker.compose.project"],
      state.project
    );
  }
  return containers;
};
const serviceContainer = (containers, service) => {
  const matching = containers.filter(
    (entry) => entry.Config.Labels["com.docker.compose.service"] === service
  );
  assert.equal(matching.length, 1, `Expected one owned ${service} container`);
  return matching[0];
};
const fetchOk = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200, `${url}: HTTP ${response.status}`);
  return response;
};
const doctor = async (state) => {
  const revision = await execute("git", ["rev-parse", "HEAD"]);
  assert.equal(
    revision.stdout.trim(),
    state.sha,
    "HEAD changed since launch; launch a new run"
  );
  const bootPath = path.join(
    root,
    "artifacts/slice-1",
    state.sha,
    state.project,
    "boot.json"
  );
  const boot = z
    .object({
      fixtureId: z.string(),
      sha: z.string(),
      sourceCheckoutDirty: z.boolean(),
      images: z.array(z.object({ id: z.string(), service: z.string() })),
    })
    .parse(JSON.parse(await readFile(bootPath, "utf-8")));
  assert.equal(boot.fixtureId, state.project);
  assert.equal(boot.sha, state.sha);
  const containers = await ownedContainers(state);
  for (const [service, internalPort, port] of [
    ["celld", "8080/tcp", state.apiPort],
    ["web", "3001/tcp", state.webPort],
    ["fixture", "8090/tcp", state.fixturePort],
  ]) {
    const container = serviceContainer(containers, service);
    assert.ok(container.State.Running, `${service} is stopped`);
    assert.equal(
      container.Image,
      boot.images.find((entry) => entry.service === service)?.id
    );
    assert.deepEqual(container.HostConfig.PortBindings?.[internalPort], [
      { HostIp: "127.0.0.1", HostPort: String(port) },
    ]);
  }
  const apiUrl = `http://localhost:${state.apiPort}`;
  const webUrl = `http://localhost:${state.webPort}`;
  const fixtureUrl = `http://localhost:${state.fixturePort}`;
  const health = await fetchOk(`${fixtureUrl}/health`);
  const identity = await health.json();
  assert.equal(identity.fixtureId, state.project);
  assert.equal(identity.sha, state.sha);
  const readiness = await fetchOk(`${apiUrl}/ready`);
  const ready = await readiness.json();
  assert.equal(ready.ok, true);
  const web = await fetchOk(`${webUrl}/login`);
  await web.body?.cancel();
  const anonymous = await fetch(`${apiUrl}/api/product/setup`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(
    anonymous.status,
    401,
    "Unauthenticated setup must require sign-in"
  );
  await anonymous.body?.cancel();
  return {
    apiUrl,
    bootPath,
    fixtureUrl,
    ok: true,
    project: state.project,
    sha: state.sha,
    sourceCheckoutDirty: boot.sourceCheckoutDirty,
    webUrl,
  };
};

if (command === "launch") {
  await mkdir(directory, { recursive: true });
  const revision = await execute("git", ["rev-parse", "HEAD"]);
  const sha = revision.stdout.trim();
  const ports = new Set([await freePort(), await freePort(), await freePort()]);
  assert.equal(ports.size, 3, "Retry with a new run ID if ports collide");
  const [apiPort, webPort, fixturePort] = [...ports];
  const state = stateSchema.parse({
    apiPort,
    fixturePort,
    project: `cerebro-s1-verify-${runId}`,
    sha,
    webPort,
  });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    flag: "wx",
  });
  process.stdout.write(`Building isolated stack. Evidence: ${directory}\n`);
  try {
    const result = await execute(process.execPath, bootArgs(state), {
      timeout: 20 * 60_000,
    });
    await writeFile(
      path.join(directory, "launch.log"),
      result.stdout + result.stderr
    );
    process.stdout.write(`${JSON.stringify(await doctor(state), null, 2)}\n`);
  } catch (error) {
    if (error instanceof Error && "stdout" in error && "stderr" in error) {
      await writeFile(
        path.join(directory, "launch.log"),
        String(error.stdout) + String(error.stderr)
      );
    }
    process.stderr.write(
      `Launch failed. Run cleanup ${runId} before a new attempt.\n`
    );
    throw error;
  }
} else {
  const state = await readState();
  if (command === "cleanup") {
    const existingContainers = await ownedContainers(state);
    const existingVolumes = await execute("docker", [
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${state.project}`,
    ]);
    let message = `No containers or volumes remain for ${state.project}\n`;
    if (existingContainers.length > 0 || existingVolumes.stdout.trim()) {
      const result = await execute(process.execPath, [
        ...bootArgs(state),
        "--down",
      ]);
      message = result.stdout;
    }
    const containers = await ownedContainers(state);
    assert.equal(containers.length, 0);
    const volumes = await execute("docker", [
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${state.project}`,
    ]);
    assert.equal(volumes.stdout.trim(), "");
    await writeJson("cleanup.json", {
      cleanedAt: new Date().toISOString(),
      evidenceDirectory: directory,
      project: state.project,
      containers: 0,
      volumes: 0,
    });
    process.stdout.write(message);
  } else {
    const report = await doctor(state);
    if (command === "doctor") {
      await writeJson("doctor.json", report);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else if (command === "token") {
      const container = serviceContainer(
        await ownedContainers(state),
        "fixture"
      );
      const token = await execute("docker", [
        "exec",
        container.Id,
        "cat",
        "/run/cerebro-secrets/bootstrap-token",
      ]);
      process.stdout.write(token.stdout);
    } else {
      const container = serviceContainer(
        await ownedContainers(state),
        "postgres"
      );
      const query = `BEGIN READ ONLY; SELECT json_build_object('users', (SELECT count(*) FROM "user"), 'setups', (SELECT count(*) FROM installation_setup), 'agents', (SELECT coalesce(json_agg(json_build_object('id', agent_id, 'name', name)), '[]') FROM agent), 'agentVersions', (SELECT count(*) FROM agent_version), 'conversations', (SELECT count(*) FROM channel_conversation), 'skills', (SELECT coalesce(json_agg(json_build_object('name', name, 'description', description, 'body', body)), '[]') FROM skill)); COMMIT;`;
      const rows = await execute("docker", [
        "exec",
        container.Id,
        "psql",
        "-U",
        "cerebro",
        "-d",
        "cerebro",
        "-v",
        "ON_ERROR_STOP=1",
        "-qAt",
        "-c",
        query,
      ]);
      const observed = await fetchOk(`${report.fixtureUrl}/observations`);
      const observations = await observed.json();
      const evidence = {
        capturedAt: new Date().toISOString(),
        database: JSON.parse(rows.stdout.trim()),
        observations,
        project: state.project,
      };
      await writeJson(`observations-${Date.now()}.json`, evidence);
      process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    }
  }
}
