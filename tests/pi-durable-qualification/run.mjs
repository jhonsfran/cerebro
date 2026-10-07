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
const timeline = [];
const pendingCases = [
  "idle eviction mid-turn",
  "snapshot attachment race",
  "observer overflow",
  "Cerebro intent/engine/projection crash boundaries",
  "replace interruption and retry between abort and submit",
  "Cerebro changed-input conflict on real host",
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
  "native active abort preserves already-queued follow-up",
  "native durable duplicate submission",
  "native request ID deduplication boundary",
  "native follow-ups run in order",
  "native steering joins the current run after a tool round",
  "native cancel queued B preserves active A",
  "native stop then submit replacement",
  "native process restart recovers Pi-queued B",
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
const counter = (root, name) =>
  root.counters.find((row) => row.name === name)?.value ?? 0;

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
    "Twelve focused tests on Effect 4; no durability inference"
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
  // Preserve the original plan case as an executed failure. Native Stop clears
  // queued inputs by design; the operator chose these semantics over a second queue.
  await probe("abort-scope", "/submit", { requestId: "run-A", text: "first" });
  await probe("abort-scope", "/submit", { requestId: "run-B", text: "second" });
  const abortBefore = await probe("abort-scope", "/pending");
  assert.equal(
    abortBefore.find((run) => run.operationId === "run-B").status,
    "queued"
  );
  await probe("abort-scope", "/cancel", { requestId: "run-A" });
  const abortAfter = await probe("abort-scope", "/pending");
  record(
    "native active abort preserves already-queued follow-up",
    abortAfter.some((run) => run.operationId === "run-B") ? "PASS" : "FAIL",
    {
      after: abortAfter,
      before: abortBefore,
      note: "Original plan requirement superseded by operator: use native Stop semantics, which withdraw queued inputs. This is expected framework behavior, not a queue defect.",
    },
    "operator-approved-semantics-change"
  );

  const first = await probe("duplicate", "/submit", {
    requestId: "run-A",
    text: "first",
  });
  const duplicate = await probe("duplicate", "/submit", {
    requestId: "run-A",
    text: "first",
  });
  assert.equal(first.accepted, true);
  assert.equal(duplicate.accepted, false);
  record("native durable duplicate submission", "PASS", { duplicate, first });
  const changed = await probe("duplicate", "/submit", {
    requestId: "run-A",
    text: "changed",
  });
  assert.equal(changed.accepted, false);
  const original = await probe("duplicate", "/wait?requestId=run-A");
  const duplicateRoot = await probe("duplicate", "/");
  assert.equal(original.status, "done");
  assert.equal(counter(duplicateRoot, "model_calls"), 1);
  assert.ok(!JSON.stringify(duplicateRoot.calls).includes("changed"));
  record("native request ID deduplication boundary", "PASS", {
    changed,
    counters: duplicateRoot.counters,
    note: "Pi deduplicates by ID and retains the first payload; it does not enforce changed-input 409. Cerebro retains that check in its command journal. Real-host Cerebro enforcement remains NOT_RUN.",
    original,
  });

  await probe("follow-up", "/submit", { requestId: "run-A", text: "first" });
  await probe("follow-up", "/submit", { requestId: "run-B", text: "second" });
  const followBefore = await probe("follow-up", "/pending");
  const followSnapshot = await probe("follow-up", "/snapshot");
  assert.equal(
    followBefore.find((run) => run.operationId === "run-A").status,
    "running"
  );
  assert.equal(
    followBefore.find((run) => run.operationId === "run-B").status,
    "queued"
  );
  assert.equal(followSnapshot.run.inputs.length, 1);
  assert.equal(followSnapshot.inbox[0].mode, "followUp");
  const followA = await probe("follow-up", "/wait?requestId=run-A");
  const followB = await probe("follow-up", "/wait?requestId=run-B");
  const followRoot = await probe("follow-up", "/");
  assert.equal(followA.status, "done");
  assert.equal(followB.status, "done");
  assert.equal(counter(followRoot, "model_calls"), 2);
  assert.ok(!followRoot.calls[0].messages.includes("second"));
  assert.ok(followRoot.calls[1].messages.includes("second"));
  assert.ok(
    followRoot.tables.every((table) => table.name !== "cerebro_admissions")
  );
  record("native follow-ups run in order", "PASS", {
    before: followBefore,
    counters: followRoot.counters,
    results: [followA, followB],
    snapshot: followSnapshot,
    tables: followRoot.tables,
  });

  await probe("steer", "/submit", {
    requestId: "run-A",
    text: "tool-before-steer",
  });
  await probe("steer", "/steer", {
    requestId: "run-B",
    text: "use the corrected instructions",
  });
  const steerBefore = await probe("steer", "/snapshot");
  assert.equal(steerBefore.inbox[0].mode, "steer");
  let joined;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    joined = await probe("steer", "/snapshot");
    if (joined.run?.inputs.length === 2) {
      break;
    }
    await delay(250);
  }
  assert.equal(joined.run?.inputs.length, 2);
  const steerA = await probe("steer", "/wait?requestId=run-A");
  const steerB = await probe("steer", "/wait?requestId=run-B");
  const steerRoot = await probe("steer", "/");
  assert.equal(steerA.status, "done");
  assert.equal(steerB.status, "done");
  assert.equal(counter(steerRoot, "model_calls"), 2);
  assert.equal(counter(steerRoot, "tool_calls"), 1);
  assert.ok(
    steerRoot.calls[1].messages.includes("use the corrected instructions")
  );
  record("native steering joins the current run after a tool round", "PASS", {
    before: steerBefore,
    counters: steerRoot.counters,
    joined,
    results: [steerA, steerB],
  });

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
  const queuedA = await probe("queued-cancel", "/wait?requestId=run-A");
  const queuedB = await probe("queued-cancel", "/wait?requestId=run-B");
  const queuedRoot = await probe("queued-cancel", "/");
  assert.equal(cancelled.cancelled, true);
  assert.equal(queuedA.status, "done");
  assert.equal(queuedB.status, "unanswered");
  assert.equal(counter(queuedRoot, "model_calls"), 1);
  record("native cancel queued B preserves active A", "PASS", {
    cancelled,
    counters: queuedRoot.counters,
    results: [queuedA, queuedB],
  });

  await probe("replace", "/submit", {
    requestId: "run-A",
    text: "original task",
  });
  const replaceBefore = await probe("replace", "/pending");
  assert.equal(replaceBefore[0].status, "running");
  const replacement = await probe("replace", "/replace", {
    requestId: "run-B",
    text: "replacement task",
  });
  const replaceA = await probe("replace", "/wait?requestId=run-A");
  const replaceB = await probe("replace", "/wait?requestId=run-B");
  const replaceRoot = await probe("replace", "/");
  assert.equal(replacement.accepted, true);
  assert.equal(replaceA.status, "unanswered");
  assert.equal(replaceA.reason, "aborted");
  assert.equal(replaceB.status, "done");
  assert.equal(counter(replaceRoot, "model_calls"), 2);
  record("native stop then submit replacement", "PASS", {
    before: replaceBefore,
    counters: replaceRoot.counters,
    note: "Native abort then submit sequence; no crash injected between calls. Not atomic, not a durable replacement adapter.",
    replacement,
    results: [replaceA, replaceB],
  });

  await probe("restart", "/submit", { requestId: "run-A", text: "first" });
  await probe("restart", "/submit", { requestId: "run-B", text: "second" });
  const restartBefore = await probe("restart", "/pending");
  const wakeBefore = await probe("restart", "/");
  assert.equal(
    restartBefore.find((run) => run.operationId === "run-B").status,
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
  // No worker request is sent during the alarm recovery window.
  await delay(45_000);
  await command("wrapper-alarm-only-timeline", [
    "docker",
    "logs",
    wrapper.name,
  ]);
  // Read a snapshot before waiting: wait() could otherwise finish work after
  // HTTP resumes and falsely look like alarm-only completion.
  const recoveredSnapshot = await probe("restart", "/snapshot");
  assert.equal(recoveredSnapshot.run, undefined);
  assert.deepEqual(recoveredSnapshot.inbox, []);
  const recoveredA = await probe("restart", "/wait?requestId=run-A");
  const recoveredB = await probe("restart", "/wait?requestId=run-B");
  const remaining = await probe("restart", "/pending");
  const recoveredRoot = await probe("restart", "/");
  assert.equal(recoveredA.status, "done");
  assert.equal(recoveredB.status, "done");
  assert.deepEqual(remaining, []);
  const recovered = [recoveredA, recoveredB];
  record("native process restart recovers Pi-queued B", "PASS", {
    before: restartBefore,
    counters: recoveredRoot.counters,
    recovered,
    snapshot: recoveredSnapshot,
    wakeBefore: wakeBefore.alarm,
  });
  record("alarm-only completion", "PASS", {
    mode: "celld dev local storage; no HTTP request for forty-five seconds after process restart",
    recovered,
    snapshot: recoveredSnapshot,
    timeline: "wrapper-alarm-only-timeline.txt",
  });
  await writeFile(
    join(evidence, "wrapper-timeline.json"),
    `${JSON.stringify(timeline, null, 2)}\n`
  );
} catch (error) {
  record("qualification runner", "FAIL", String(error));
} finally {
  await writeFile(
    join(evidence, "wrapper-timeline.json"),
    `${JSON.stringify(timeline, null, 2)}\n`
  );
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
    `${JSON.stringify({ contractStatus: "ready for coordinator review; qualification incomplete", hostImage: request.hostImage, lockSha256: lockHash, mode: "celld dev with persistent local storage and nodejs_compat; not production bucket", results, selectedImplementation: "official PiHarness + Lifecycle; native inbox, steering and stop; thin Effect adapter", sourceSha }, null, 2)}\n`
  );
  process.stdout.write(`Evidence: ${evidence}\n`);
  process.exitCode = results.some(
    (result) => result.status === "FAIL" || result.status === "NOT_RUN"
  )
    ? 1
    : 0;
}
