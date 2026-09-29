import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const sourceResults = fileURLToPath(new URL("../results/", import.meta.url));
const resultsDirectory = process.env.RESULTS_DIR ?? sourceResults;
const project = process.env.COMPOSE_PROJECT_NAME ?? "cerebro-slice";
const compose = [
  "proxy",
  "docker",
  "compose",
  "-p",
  project,
  "-f",
  "experiments/celld-slice/compose.yaml",
];
const worker = "cerebro-celld-slice";
const limits = {
  idleMs: 120_000,
  maxOngoingRequests: 0,
  maxRetiringIsolates: 0,
  minimumRepetitions: 2,
};
const emit = (event) =>
  process.stdout.write(
    `${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`
  );
const requireValue = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};
const run = async (args, timeoutMs = 15_000, env = process.env) => {
  const child = spawn("rtk", args, {
    cwd: root,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let failure = null;
  const stop = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        failure ??= "Could not stop lifecycle child process";
      }
    }
  };
  const timer = setTimeout(() => {
    failure = "Lifecycle child process exceeded its deadline";
    stop();
  }, timeoutMs);
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    if (output.length + chunk.length > 2_097_152) {
      failure = "Lifecycle child output exceeded its limit";
      stop();
      return;
    }
    output += chunk;
  });
  child.stderr.resume();
  const completed = Promise.withResolvers();
  child.once("error", () => {
    failure = "Lifecycle child process failed to start";
  });
  child.once("close", (code, signal) => completed.resolve({ code, signal }));
  const result = await completed.promise;
  clearTimeout(timer);
  requireValue(!failure, failure);
  requireValue(
    result.signal === null,
    "Lifecycle child process ended by signal"
  );
  return { ...result, output: output.trim() };
};
const jsonCommand = async (args, timeoutMs) => {
  const result = await run(args, timeoutMs);
  requireValue(result.code === 0, "Lifecycle observation command failed");
  try {
    return JSON.parse(result.output);
  } catch {
    throw new Error("Lifecycle observation was not JSON");
  }
};
const inspectFormat =
  '{"id":{{json .Id}},"imageId":{{json .Image}},"startedAt":{{json .State.StartedAt}},"running":{{json .State.Running}}}';
const stateScript = `const response = await fetch('http://localhost:8081/state', {signal: AbortSignal.timeout(5000)}); if (!response.ok) throw Error('state failed'); const {deployment} = await response.json(); const keys = ['CELLD_V8_HEAP_LIMIT_MB','CELLD_IDLE_EVICT_S','CELLD_MAX_RESIDENT_CELLS']; console.log(JSON.stringify({deployment,config:Object.fromEntries(keys.map(key=>[key,process.env[key]??null]))}));`;
const samples = [];
const repetitions = [];
const report = {
  error: null,
  finalCensus: null,
  historicalFailureArtifact: "29-post-load-failure.json",
  imageId: null,
  limits,
  noDeploymentReset: false,
  ok: false,
  project,
  repetitions,
  samples,
  stableVersion: false,
  startedAt: new Date().toISOString(),
  workerVersion: null,
};
let original;
let stage = "initial-observation";
const observe = async (phase, deadline = Infinity) => {
  const timeout = () => {
    const remaining = deadline - performance.now();
    requireValue(
      remaining > 0,
      "Lifecycle observation exceeded the idle deadline"
    );
    return Math.min(15_000, remaining);
  };
  const selected = await run([...compose, "ps", "-q", "celld"], timeout());
  requireValue(
    selected.code === 0 && /^[a-f0-9]{12,64}$/u.test(selected.output),
    "Could not identify exactly one celld container"
  );
  const identity = await jsonCommand(
    ["proxy", "docker", "inspect", "--format", inspectFormat, selected.output],
    timeout()
  );
  requireValue(identity.running === true, "celld container is not running");
  const state = await jsonCommand(
    [
      "proxy",
      "docker",
      "exec",
      identity.id,
      "node",
      "--input-type=module",
      "-e",
      stateScript,
    ],
    timeout()
  );
  const { deployment, config } = state;
  requireValue(
    typeof deployment?.version === "string" &&
      Number.isInteger(deployment.generation),
    "Deployment identity is missing"
  );
  const census = deployment.isolates?.cells?.[worker];
  requireValue(
    census &&
      [
        "cells",
        "requests",
        "retiring",
        "turns",
        "heap_bytes",
        "live",
        "live_empty",
      ].every((key) => Number.isFinite(census[key]) && census[key] >= 0),
    "Worker census is missing or invalid"
  );
  const sample = {
    census,
    config,
    draining: deployment.draining,
    generation: deployment.generation,
    identity,
    isolates: deployment.isolates,
    phase,
    timestamp: new Date().toISOString(),
    version: deployment.version,
  };
  samples.push(sample);
  if (original) {
    requireValue(
      identity.id === original.identity.id &&
        identity.imageId === original.identity.imageId &&
        identity.startedAt === original.identity.startedAt,
      "celld container was replaced, restarted, or changed image"
    );
    requireValue(
      sample.version === original.version &&
        sample.generation === original.generation,
      "Worker deployment changed during lifecycle check"
    );
    requireValue(
      JSON.stringify(config) === JSON.stringify(original.config),
      "celld capacity configuration changed"
    );
  }
  return sample;
};
const readJSON = async (file) =>
  JSON.parse(await readFile(path.join(sourceResults, file), "utf-8"));
const snapshot = async (roundDirectory, files) => {
  await mkdir(roundDirectory, { recursive: true });
  await Promise.all(
    files.map(
      async (file) =>
        await copyFile(
          path.join(sourceResults, file),
          path.join(roundDirectory, file)
        )
    )
  );
};
try {
  await mkdir(resultsDirectory, { recursive: true });
  original = await observe("before-workloads");
  report.imageId = original.identity.imageId;
  report.workerVersion = original.version;
  report.containerIdentity = original.identity;
  report.config = original.config;
  const runRound = async (round) => {
    emit({ event: "lifecycle.round.start", round });
    const roundDirectory = path.join(
      resultsDirectory,
      `lifecycle-round-${round}`
    );
    const repetition = {
      baselineOk: false,
      mainFail: null,
      mainPass: null,
      round,
      startedAt: new Date().toISOString(),
    };
    repetitions.push(repetition);
    stage = `round-${round}-main`;
    const existing = new Set(await readdir(sourceResults));
    const main = await run(
      [
        ...compose,
        "run",
        "--rm",
        "--no-deps",
        "check",
        "node",
        "scripts/check.mjs",
      ],
      300_000
    );
    const currentFiles = await readdir(sourceResults);
    const freshReports = currentFiles.filter(
      (file) => /^check-\d+\.json$/u.test(file) && !existing.has(file)
    );
    requireValue(
      freshReports.length === 1,
      "Main check did not produce exactly one new report"
    );
    const [mainReportFile] = freshReports;
    const mainReport = await readJSON(mainReportFile);
    await snapshot(roundDirectory, [
      mainReportFile,
      "broker-evidence.json",
      "tool-denial-evidence.json",
      "reconnect-evidence.json",
    ]);
    requireValue(
      Array.isArray(mainReport.results),
      "Main report has no results"
    );
    repetition.mainPass = mainReport.results.filter(
      (result) => result.status === "pass"
    ).length;
    repetition.mainFail = mainReport.results.filter(
      (result) => result.status === "fail"
    ).length;
    repetition.mainExit = main.code;
    repetition.mainReport = mainReportFile;
    requireValue(
      main.code === 1 &&
        mainReport.gate === "incomplete" &&
        repetition.mainPass === 25 &&
        repetition.mainFail === 0,
      "Main check did not meet expected incomplete/25-pass/zero-failure result"
    );
    await observe(`round-${round}-after-main`);
    stage = `round-${round}-baseline`;
    const baselineStarted = Date.now();
    const baseline = await run(
      [
        "proxy",
        process.execPath,
        "experiments/celld-slice/scripts/check-baseline-host.mjs",
      ],
      240_000,
      {
        ...process.env,
        COMPOSE_PROJECT_NAME: project,
        RESULTS_DIR: sourceResults,
      }
    );
    const memory = await readJSON("baseline-memory.json");
    const workload = await readJSON("baseline-evidence.json");
    await snapshot(roundDirectory, [
      "baseline-memory.json",
      "baseline-evidence.json",
    ]);
    requireValue(
      Date.parse(memory.startedAt) >= baselineStarted - 1000 &&
        Date.parse(workload.timestamp) >= baselineStarted - 1000,
      "Baseline reports are stale"
    );
    repetition.baselineExit = baseline.code;
    repetition.baselineOk =
      baseline.code === 0 && memory.ok === true && workload.ok === true;
    requireValue(
      repetition.baselineOk,
      "Baseline workload or memory observation failed"
    );
    await observe(`round-${round}-after-baseline`);
    repetition.finishedAt = new Date().toISOString();
    emit({
      baselineOk: repetition.baselineOk,
      event: "lifecycle.round.complete",
      mainFail: repetition.mainFail,
      mainPass: repetition.mainPass,
      round,
    });
  };
  await runRound(1);
  await runRound(2);
  stage = "idle-drain";
  emit({ deadlineMs: limits.idleMs, event: "lifecycle.drain.start" });
  const idleStarted = performance.now();
  const awaitIdle = async () => {
    const sample = await observe("idle-drain", idleStarted + limits.idleMs);
    const idleMs = Math.round(performance.now() - idleStarted);
    const { census } = sample;
    requireValue(
      idleMs <= limits.idleMs,
      "Lifecycle idle observation exceeded 120 seconds"
    );
    report.finalCensus = {
      ...census,
      idleMs,
      ongoingRequests: census.requests,
      retiringIsolates: census.retiring,
      timestamp: sample.timestamp,
    };
    if (
      census.cells === 0 &&
      census.requests === 0 &&
      census.retiring === 0 &&
      census.turns === 0
    ) {
      return;
    }
    requireValue(
      idleMs < limits.idleMs,
      "Worker did not drain cells, requests, retiring isolates, and turns within 120 seconds"
    );
    await delay(Math.min(5000, limits.idleMs - idleMs));
    await awaitIdle();
  };
  await awaitIdle();
  report.stableVersion = true;
  report.noDeploymentReset = true;
  report.ok = true;
} catch (error) {
  report.error = {
    message: error instanceof Error ? error.message : "Lifecycle check failed",
    stage,
  };
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(
    path.join(resultsDirectory, "lifecycle-evidence.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  emit({
    error: report.error,
    event: "lifecycle.complete",
    finalCensus: report.finalCensus,
    ok: report.ok,
  });
  process.exitCode = report.ok ? 0 : 1;
}
