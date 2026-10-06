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
const sourceSha = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repo,
  encoding: "utf-8",
}).stdout.trim();
const record = (name, status, details) => {
  results.push({ details, name, status });
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
    ...(kind === "wrapper" ? ["--external:node:*"] : []),
    `--outfile=${project}/bundle.mjs`,
    `--metafile=${evidence}/${kind}-bundle-meta.json`,
  ]);
  await writeFile(
    join(project, "wrangler.json"),
    JSON.stringify({
      ...(kind === "wrapper" ? { compatibility_flags: ["nodejs_compat"] } : {}),
      compatibility_date: "2026-10-05",
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
      await http(base, kind === "conformance" ? "/cases" : "/");
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
    join(work, "npm-cache"),
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
  for (const file of [
    "wrapper-worker.mjs",
    "direct-worker.mjs",
    "conformance-worker.mjs",
    "sqlite.mjs",
    "tanstack.test.mjs",
  ]) {
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
    "Eight focused tests; no durability inference"
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
  const wrapper = await start("wrapper", "wrapper-worker.mjs");
  const timeline = [];
  const probe = async (path, body) => {
    const value = await http(wrapper.base, path, body);
    timeline.push({ at: new Date().toISOString(), path, value });
    return value;
  };
  const first = await probe("/submit", { requestId: "run-A", text: "first" });
  const duplicate = await probe("/submit", {
    requestId: "run-A",
    text: "first",
  });
  assert.equal(first.accepted, true);
  assert.equal(duplicate.accepted, false);
  record(
    "wrapper durable duplicate submission",
    "PASS",
    "Same request id returns accepted:false"
  );
  await probe("/submit", { requestId: "run-B", text: "second" });
  await delay(100);
  const before = await probe("/pending");
  assert.ok(
    before.some((r) => r.operationId === "run-A" && r.status === "running")
  );
  assert.ok(
    before.some((r) => r.operationId === "run-B" && r.status === "queued")
  );
  await probe("/cancel", { requestId: "run-A" });
  await probe("/");
  const after = await probe("/pending");
  await writeFile(
    join(evidence, "wrapper-cancel.json"),
    `${JSON.stringify(timeline, null, 2)}\n`
  );
  record(
    "wrapper cancel A preserves queued B",
    after.some((r) => r.operationId === "run-B") ? "PASS" : "FAIL",
    { after, before }
  );
  // The concrete wrapper failure permits only a qualification fallback, not application wiring.
  const conformance = await start("conformance", "conformance-worker.mjs");
  const cases = await http(conformance.base, "/cases");
  const storageResults = [];
  for (let index = 0; index < cases.length; index += 1) {
    const response = await fetch(`${conformance.base}/?index=${index}`, {
      signal: AbortSignal.timeout(20_000),
    });
    storageResults.push(await response.json());
  }
  const transaction = await http(conformance.base, "/transaction");
  await writeFile(
    join(evidence, "direct-conformance.json"),
    `${JSON.stringify({ cases: storageResults, transaction }, null, 2)}\n`
  );
  record(
    "direct storage conformance and transaction ordering",
    storageResults.every((r) => r.status === "PASS") ? "PASS" : "FAIL",
    { cases: cases.length, transaction }
  );
  const direct = await start("direct", "direct-worker.mjs");
  const directTimeline = [];
  const dprobe = async (path, body) => {
    const value = await http(direct.base, path, body);
    directTimeline.push({ at: new Date().toISOString(), path, value });
    return value;
  };
  const dfirst = await dprobe("/submit", { requestId: "run-A", text: "first" });
  const ddup = await dprobe("/submit", { requestId: "run-A", text: "first" });
  assert.equal(dfirst.id, ddup.id);
  await dprobe("/submit", { requestId: "run-B", text: "second" });
  await delay(100);
  await dprobe("/inspect");
  await dprobe("/cancel", { requestId: "run-A" });
  await delay(12_000);
  const stalled = await dprobe("/receipt?requestId=run-B");
  await dprobe("/");
  record(
    "direct cancel A allows queued B progress",
    stalled.status === "done" ? "PASS" : "FAIL",
    stalled
  );
  await command("direct-kill", ["docker", "kill", direct.name]);
  await command("direct-restart", ["docker", "start", direct.name]);
  // No worker request while testing alarm recovery.
  const restartedPortOutput = await command("direct-restart-port", [
    "docker",
    "port",
    direct.name,
    "9876",
  ]);
  direct.base = `http://127.0.0.1:${restartedPortOutput.trim().split(":").at(-1)}`;
  await delay(15_000);
  await command("direct-alarm-only-timeline", ["docker", "logs", direct.name]);
  const recovered = await dprobe("/receipt?requestId=run-B");
  await dprobe("/");
  record(
    "direct process restart recovers queued B",
    recovered.status === "done" ? "PASS" : "FAIL",
    recovered
  );
  await writeFile(
    join(evidence, "direct-timeline.json"),
    `${JSON.stringify(directTimeline, null, 2)}\n`
  );
  for (const name of [
    "changed-input admission conflict",
    "idle eviction mid-turn",
    "alarm-only completion",
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
  ]) {
    record(
      name,
      "NOT_RUN",
      "Stopped at candidate cancellation/recovery gate; no host qualification inferred from fakes"
    );
  }
} catch (error) {
  record("qualification runner", "FAIL", String(error));
} finally {
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
    `${JSON.stringify({ contractStatus: "proposed; freeze blocked", hostImage: request.hostImage, lockSha256: lockHash, mode: "celld dev with persistent local storage; not production bucket", results, selectedImplementation: null, sourceSha }, null, 2)}\n`
  );
  process.stdout.write(`Evidence: ${evidence}\n`);
  process.exitCode = results.some(
    (result) => result.status === "FAIL" || result.status === "NOT_RUN"
  )
    ? 1
    : 0;
}
