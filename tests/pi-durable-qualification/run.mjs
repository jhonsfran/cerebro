/* oxlint-disable no-await-in-loop -- Host startup polls, case timelines and cleanup must retain their recorded order. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import pathModule from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const { join, resolve } = pathModule;
const source = import.meta.dirname;
const repo = resolve(source, "../..");
const request = JSON.parse(
  await readFile(join(source, "dependency-requests.json"), "utf-8")
);
const work = await mkdtemp(join(tmpdir(), "cerebro-s1-0-"));
const evidence = process.env.S1_0_EVIDENCE_DIR ?? join(work, "evidence");
await mkdir(evidence, { recursive: true });
const containers = [];
const results = [];
const pendingCases = [
  "idle eviction mid-turn",
  "snapshot attachment race",
  "observer overflow",
  "five handoff crash boundaries",
  "controlled provider retries and compaction",
  "current model permission at physical dispatch",
  "approval across eviction",
  "denied or revoked approval zero physical tool dispatches",
  "uncertain write reconciliation",
  "Effect interruption reaches provider and tool",
  "real browser page load / approval / reconnect",
  "production bucket durability / flush before acknowledgment",
];
const plannedChecks = [
  "isolated resolved graph",
  "proposed Effect contract fakes",
  "proposed contract types",
  "TanStack public lifecycle",
  "wrapper worker path without Node imports",
  "raw PiHarness cancel A preserves Pi-queued B",
  "wrapper durable duplicate admission",
  "changed-input admission conflict",
  "wrapper cancel A preserves and completes host-queued B",
  "wrapper cancel queued B preserves active A",
  "wrapper process restart recovers host-queued B",
  "alarm-only completion",
  ...pendingCases,
];
const sourceSha = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repo,
  encoding: "utf-8",
}).stdout.trim();
const record = (name, status, details, disposition) => {
  results.push({ details, disposition, name, status });
  process.stdout.write(`${status} ${name}\n`);
};
const command = async (name, args, cwd = work) => {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  });
  await writeFile(
    join(evidence, `${name}.txt`),
    `${result.stdout ?? ""}${result.stderr ?? ""}`
  );
  if (result.status !== 0) {
    throw new Error(`${name}: exit ${result.status}; see ${name}.txt`);
  }
  return result.stdout;
};
const http = async (base, path, body) => {
  const response = await fetch(
    base + path,
    body
      ? {
          body: JSON.stringify(body),
          method: "POST",
          signal: AbortSignal.timeout(20_000),
        }
      : { signal: AbortSignal.timeout(20_000) }
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
};
const start = async (kind, entry) => {
  const project = join(work, kind);
  await mkdir(project);
  await command(`${kind}-bundle`, [
    join(work, "node_modules/@esbuild/linux-x64/bin/esbuild"),
    join(work, entry),
    "--bundle",
    "--format=esm",
    "--platform=browser",
    "--external:cloudflare:workers",
    "--external:node:*",
    `--outfile=${project}/bundle.mjs`,
    `--metafile=${evidence}/${kind}-bundle-meta.json`,
  ]);
  await writeFile(
    join(project, "wrangler.json"),
    JSON.stringify({
      compatibility_date: "2026-10-05",
      compatibility_flags: ["nodejs_compat"],
      durable_objects: {
        bindings: [{ class_name: "Qualification", name: "QUALIFICATION" }],
      },
      main: "bundle.mjs",
      migrations: [{ new_sqlite_classes: ["Qualification"], tag: "v1" }],
      name: `cerebro-qualification-${kind}`,
    })
  );
  const name = `cerebro-s1-0-${kind}-${work.split("-").at(-1).toLowerCase()}`;
  containers.push(name);
  await command(`${kind}-start`, [
    "docker",
    "run",
    "-d",
    "--name",
    name,
    "--mount",
    `type=bind,src=${project},dst=/proof`,
    "--mount",
    `type=bind,src=${work}/node_modules/@esbuild/linux-x64/bin/esbuild,dst=/esbuild,readonly`,
    "-w",
    "/proof",
    "-e",
    "CELLD_ESBUILD=/esbuild",
    "-e",
    "CELLD_TELEMETRY=0",
    "-e",
    "CELLD_IDLE_EVICT_S=2",
    "-p",
    "127.0.0.1::9876",
    request.hostImage,
    "dev",
    ".",
    "--host",
    "0.0.0.0",
    "--port",
    "9876",
    "--logs",
    "--no-watch",
  ]);
  const portOutput = await command(`${kind}-port`, [
    "docker",
    "port",
    name,
    "9876",
  ]);
  const port = portOutput.trim().split(":").at(-1);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      await http(base, "/");
      return { base, name };
    } catch {
      await delay(100);
    }
  }
  throw new Error(`${kind} host did not become ready`);
};
try {
  await writeFile(
    join(work, "package.json"),
    JSON.stringify({
      dependencies: request.pins,
      private: true,
      type: "module",
    })
  );
  await cp(
    join(source, "evidence/isolated-install-lock.json"),
    join(work, "package-lock.json")
  );
  await command("install", [
    "npm",
    "ci",
    "--ignore-scripts",
    "--workspaces=false",
    "--cache",
    process.env.S1_0_NPM_CACHE ?? join(work, "npm-cache"),
  ]);
  const lock = JSON.parse(
    await readFile(join(work, "package-lock.json"), "utf-8")
  );
  const forbidden = Object.keys(lock.packages)
    .map((path) => path.slice(path.lastIndexOf("node_modules/") + 13))
    .filter((name) => name === "ai" || name.startsWith("@ai-sdk/"));
  assert.deepEqual(forbidden, []);
  record("isolated resolved graph", "PASS", { forbidden });
  const inventory = [];
  for (const [path, data] of Object.entries(lock.packages)) {
    if (!path) {
      continue;
    }
    let metadata;
    try {
      metadata = JSON.parse(
        await readFile(join(work, path, "package.json"), "utf-8")
      );
    } catch (error) {
      if (error.code === "ENOENT" && data.optional) {
        inventory.push({
          installed: false,
          integrity: data.integrity,
          name: path.slice(path.lastIndexOf("node_modules/") + 13),
          optional: true,
          version: data.version,
        });
        continue;
      }
      throw error;
    }
    inventory.push({
      dependencies: metadata.dependencies ?? {},
      exports: metadata.exports ?? null,
      integrity: data.integrity,
      license: metadata.license ?? null,
      name: metadata.name,
      peerDependencies: metadata.peerDependencies ?? {},
      peerDependenciesMeta: metadata.peerDependenciesMeta ?? {},
      version: metadata.version,
    });
  }
  await writeFile(
    join(evidence, "installed-packages.json"),
    `${JSON.stringify(inventory, null, 2)}\n`
  );
  for (const file of ["wrapper-worker.mjs", "tanstack.test.mjs"]) {
    await cp(join(source, file), join(work, file));
  }
  await cp(
    join(repo, "packages/contracts/src"),
    join(work, "packages/contracts/src"),
    { recursive: true }
  );
  await mkdir(join(work, "tests/pi-durable-qualification"), {
    recursive: true,
  });
  await cp(
    join(source, "contracts.test.ts"),
    join(work, "tests/pi-durable-qualification/contracts.test.ts")
  );
  await command("focused-contracts", [
    "node",
    "--test",
    "tests/pi-durable-qualification/contracts.test.ts",
  ]);
  record(
    "proposed Effect contract fakes",
    "PASS",
    "Ten focused tests on Effect 4; no durability inference"
  );
  await command("proposed-types", [
    join(work, "node_modules/.bin/tsc"),
    "--ignoreConfig",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--allowImportingTsExtensions",
    "--module",
    "ESNext",
    "--moduleResolution",
    "bundler",
    "--target",
    "ESNext",
    "--types",
    "node",
    ...[
      "session-service",
      "execution",
      "authority-service",
      "tool-service",
      "receipt-service",
      "failures",
      "metering",
      "testing/effect-fakes",
      "testing/session-fakes",
    ].map((file) => join(work, "packages/contracts/src", `${file}.ts`)),
  ]);
  record(
    "proposed contract types",
    "PASS",
    "Isolated pinned Effect install; application dependency integration is coordinator-owned"
  );
  await command("tanstack", ["node", "--test", "tanstack.test.mjs"]);
  record(
    "TanStack public lifecycle",
    "PASS",
    "hydrate/joinRun and ChatClient.attach/detach; zero submit; headless only"
  );
  const strictBundle = spawnSync(
    join(work, "node_modules/@esbuild/linux-x64/bin/esbuild"),
    [
      "wrapper-worker.mjs",
      "--bundle",
      "--format=esm",
      "--platform=browser",
      "--external:cloudflare:workers",
      `--outfile=${work}/strict-wrapper.mjs`,
    ],
    { cwd: work, encoding: "utf-8" }
  );
  await writeFile(
    join(evidence, "wrapper-strict-browser-bundle.txt"),
    `${strictBundle.stdout ?? ""}${strictBundle.stderr ?? ""}`
  );
  record(
    "wrapper worker path without Node imports",
    strictBundle.status === 0 ? "PASS" : "FAIL",
    {
      evidence: "wrapper-strict-browser-bundle.txt",
      exitCode: strictBundle.status,
      note: "Operator selected the official wrapper with nodejs_compat; the strict Node-free constraint is an accepted deviation, not a passed check.",
    },
    "accepted-deviation"
  );
  const wrapper = await start("wrapper", "wrapper-worker.mjs");
  const timeline = [];
  const probe = async (conversation, path, body) => {
    const separator = path.includes("?") ? "&" : "?";
    const value = await http(
      wrapper.base,
      `${path}${separator}conversation=${conversation}`,
      body
    );
    timeline.push({ at: new Date().toISOString(), conversation, path, value });
    return value;
  };
  // Keep the vendor limitation reproducible; do not relabel it as a pass.
  await probe("raw", "/raw/submit", { requestId: "run-A", text: "first" });
  await probe("raw", "/raw/submit", { requestId: "run-B", text: "second" });
  const rawBefore = await probe("raw", "/pending");
  assert.ok(rawBefore.some((r) => r.operationId === "run-B"));
  await probe("raw", "/raw/cancel", { requestId: "run-A" });
  const rawAfter = await probe("raw", "/pending");
  record(
    "raw PiHarness cancel A preserves Pi-queued B",
    rawAfter.some((r) => r.operationId === "run-B") ? "PASS" : "FAIL",
    { after: rawAfter, before: rawBefore },
    "documented-vendor-limitation"
  );
  const first = await probe("serial", "/submit", {
    requestId: "run-A",
    text: "first",
  });
  const duplicate = await probe("serial", "/submit", {
    requestId: "run-A",
    text: "first",
  });
  assert.equal(first.accepted, true);
  assert.equal(duplicate.accepted, false);
  record("wrapper durable duplicate admission", "PASS", { duplicate, first });
  const changed = await fetch(`${wrapper.base}/submit?conversation=serial`, {
    body: JSON.stringify({ requestId: "run-A", text: "changed" }),
    method: "POST",
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(changed.status, 409);
  record("changed-input admission conflict", "PASS", {
    body: await changed.json(),
    status: changed.status,
  });
  await probe("serial", "/submit", { requestId: "run-B", text: "second" });
  const before = await probe("serial", "/admissions");
  const piBefore = await probe("serial", "/pending");
  assert.equal(before.find((r) => r.request_id === "run-B").state, "queued");
  assert.equal(before.find((r) => r.request_id === "run-B").engine_accepted, 0);
  assert.ok(piBefore.every((r) => r.operationId === "run-A"));
  await probe("serial", "/cancel", { requestId: "run-A" });
  const after = await probe("serial", "/admissions");
  assert.equal(after.find((r) => r.request_id === "run-A").state, "cancelled");
  assert.equal(after.find((r) => r.request_id === "run-B").state, "running");
  await delay(8000);
  const completed = await probe("serial", "/receipt?requestId=run-B");
  const serialRoot = await probe("serial", "/");
  assert.equal(completed.state, "completed");
  assert.equal(JSON.parse(completed.result).status, "done");
  assert.equal(
    serialRoot.counters.find((r) => r.name === "model_calls").value,
    2
  );
  record("wrapper cancel A preserves and completes host-queued B", "PASS", {
    after,
    before,
    completed,
    counters: serialRoot.counters,
    piBefore,
  });
  // Cancelling a host-queued run never reaches Pi and cannot stop active A.
  await probe("queued-cancel", "/submit", {
    requestId: "run-A",
    text: "first",
  });
  await probe("queued-cancel", "/submit", {
    requestId: "run-B",
    text: "second",
  });
  const cancelled = await probe("queued-cancel", "/cancel", {
    requestId: "run-B",
  });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.engine_accepted, 0);
  await delay(8000);
  const surviving = await probe("queued-cancel", "/receipt?requestId=run-A");
  const queuedRoot = await probe("queued-cancel", "/");
  assert.equal(surviving.state, "completed");
  assert.equal(
    queuedRoot.counters.find((r) => r.name === "model_calls").value,
    1
  );
  record("wrapper cancel queued B preserves active A", "PASS", {
    cancelled,
    counters: queuedRoot.counters,
    surviving,
  });
  await probe("restart", "/submit", { requestId: "run-A", text: "first" });
  await probe("restart", "/submit", { requestId: "run-B", text: "second" });
  const restartBefore = await probe("restart", "/admissions");
  const wakeBefore = await probe("restart", "/");
  assert.equal(
    restartBefore.find((r) => r.request_id === "run-B").state,
    "queued"
  );
  assert.ok(wakeBefore.alarm);
  await command("wrapper-kill", ["docker", "kill", wrapper.name]);
  await command("wrapper-restart", ["docker", "start", wrapper.name]);
  const restartedPort = await command("wrapper-restart-port", [
    "docker",
    "port",
    wrapper.name,
    "9876",
  ]);
  wrapper.base = `http://127.0.0.1:${restartedPort.trim().split(":").at(-1)}`;
  // Do not send a worker request while proving an alarm completes admitted work.
  await delay(20_000);
  await command("wrapper-alarm-only-timeline", [
    "docker",
    "logs",
    wrapper.name,
  ]);
  const recovered = await probe("restart", "/admissions");
  const recoveredRoot = await probe("restart", "/");
  assert.equal(recovered.length, 2);
  assert.ok(recovered.every((r) => r.state === "completed"));
  assert.equal(
    recovered.find((r) => r.request_id === "run-B").position,
    restartBefore.find((r) => r.request_id === "run-B").position
  );
  record("wrapper process restart recovers host-queued B", "PASS", {
    before: restartBefore,
    counters: recoveredRoot.counters,
    recovered,
    wakeBefore: wakeBefore.alarm,
  });
  record("alarm-only completion", "PASS", {
    mode: "celld dev local storage; no HTTP request for twenty seconds after process restart",
    recovered,
    timeline: "wrapper-alarm-only-timeline.txt",
  });
  await writeFile(
    join(evidence, "wrapper-timeline.json"),
    `${JSON.stringify(timeline, null, 2)}\n`
  );
} catch (error) {
  record("qualification runner", "FAIL", String(error));
} finally {
  for (const name of plannedChecks) {
    if (results.some((result) => result.name === name)) {
      continue;
    }
    record(
      name,
      "NOT_RUN",
      "Deferred by operator: continue with official wrapper, retain this as a TODO; no pass claimed"
    );
  }
  for (const name of containers) {
    const log = spawnSync("docker", ["logs", name], {
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
    });
    await writeFile(
      join(evidence, `${name}.txt`),
      `${log.stdout ?? ""}${log.stderr ?? ""}`
    );
    spawnSync("docker", ["rm", "-f", name], { encoding: "utf-8" });
  }
  const lockHash = createHash("sha256")
    .update(await readFile(join(source, "evidence/isolated-install-lock.json")))
    .digest("hex");
  await writeFile(
    join(evidence, "qualification.json"),
    `${JSON.stringify({ contractStatus: "ready for coordinator review; qualification incomplete", hostImage: request.hostImage, lockSha256: lockHash, mode: "celld dev with persistent local storage and nodejs_compat; not production bucket", results, selectedImplementation: "official PiHarness + Lifecycle with serialized Cerebro admission", sourceSha }, null, 2)}\n`
  );
  process.stdout.write(`Evidence: ${evidence}\n`);
  process.exitCode = results.some(
    (result) => result.status === "FAIL" || result.status === "NOT_RUN"
  )
    ? 1
    : 0;
}
