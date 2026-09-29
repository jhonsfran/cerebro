import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const resultsDirectory =
  process.env.RESULTS_DIR ??
  fileURLToPath(new URL("../results/", import.meta.url));
const project = process.env.COMPOSE_PROJECT_NAME ?? "cerebro-slice";
const composeArgs = [
  "proxy",
  "docker",
  "compose",
  "-p",
  project,
  "-f",
  "experiments/celld-slice/compose.yaml",
];
const services = ["celld", "postgres", "fixture"];
const firstSampleTimeoutMs = 10_000;
const baselineTimeoutMs = 180_000;
const unitPattern = /^(?<amount>\d+(?:\.\d+)?)\s*(?<unit>[KMGT]?i?B|kB)$/u;
const unitBytes = {
  B: 1,
  GB: 1_000_000_000,
  GiB: 1_073_741_824,
  KB: 1000,
  KiB: 1024,
  MB: 1_000_000,
  MiB: 1_048_576,
  TB: 1_000_000_000_000,
  TiB: 1_099_511_627_776,
  kB: 1000,
};
const memoryBytes = (usage) => {
  const used = usage.split("/", 1)[0].trim();
  const match = unitPattern.exec(used);
  return match
    ? Number(match.groups.amount) * unitBytes[match.groups.unit]
    : null;
};
const inspectFormat =
  '{"id":{{json .Id}},"name":{{json .Name}},"imageId":{{json .Image}}}';
const run = (args) =>
  execFileSync("rtk", args, {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 1_048_576,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  }).trim();
const samples = [];
const containers = [];
const samplingErrors = new Set();
const stopProcess = (child, signal) => {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      samplingErrors.add("Could not stop a measurement process group");
    }
  }
};
const startedAt = new Date().toISOString();
let stats;
let statsClosed;
let statsExit = null;
let childExit = null;
let stoppingStats = false;
let stage = "container-inspection";
let error = null;
let workloadStartedAt = null;
let workloadFinishedAt = null;
try {
  for (const service of services) {
    const id = run([...composeArgs, "ps", "-q", service]);
    assert.match(id, /^[a-f0-9]{12,64}$/u);
    const info = JSON.parse(
      run(["proxy", "docker", "inspect", "--format", inspectFormat, id])
    );
    assert.equal(typeof info.id, "string");
    assert.equal(typeof info.name, "string");
    assert.equal(typeof info.imageId, "string");
    containers.push({ ...info, service });
  }
  stage = "first-memory-sample";
  const firstSample = Promise.withResolvers();
  const closed = Promise.withResolvers();
  statsClosed = closed.promise;
  stats = spawn(
    "rtk",
    [
      "proxy",
      "docker",
      "stats",
      "--format",
      "{{json .}}",
      "--no-trunc",
      ...containers.map((container) => container.id),
    ],
    {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let buffer = "";
  stats.stdout.setEncoding("utf-8");
  stats.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 65_536) {
      samplingErrors.add("Docker stats output exceeded the line buffer limit");
      firstSample.reject(new Error("Invalid Docker stats output"));
      buffer = "";
      return;
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const normalized = stripVTControlCharacters(line).trim();
      if (!normalized) {
        continue;
      }
      try {
        const value = JSON.parse(normalized);
        const container = containers.find(
          (entry) =>
            entry.id === value.ID ||
            entry.id === value.Container ||
            entry.name.slice(1) === value.Name
        );
        assert.ok(container);
        assert.equal(typeof value.MemUsage, "string");
        assert.ok(samples.length < 2000);
        samples.push({
          containerId: container.id,
          cpuPercent: typeof value.CPUPerc === "string" ? value.CPUPerc : null,
          memoryBytes: memoryBytes(value.MemUsage),
          memoryUsage: value.MemUsage,
          service: container.service,
          timestamp: new Date().toISOString(),
        });
        firstSample.resolve();
      } catch {
        samplingErrors.add("Docker stats returned an invalid or excess sample");
        firstSample.reject(new Error("Invalid Docker stats sample"));
      }
    }
  });
  stats.stderr.on("data", () => {
    if (!stoppingStats) {
      samplingErrors.add("Docker stats wrote a diagnostic; text omitted");
    }
  });
  stats.once("error", () => {
    samplingErrors.add("Docker stats process failed to start");
    firstSample.reject(new Error("Docker stats process failed"));
  });
  stats.once("close", (code, signal) => {
    statsExit = { code, signal };
    if (!stoppingStats) {
      samplingErrors.add("Docker stats stopped before workload completion");
      firstSample.reject(new Error("Docker stats process stopped"));
    }
    closed.resolve();
  });
  const firstTimer = setTimeout(() => {
    firstSample.reject(
      new Error("No Docker stats sample arrived within 10 seconds")
    );
  }, firstSampleTimeoutMs);
  try {
    await firstSample.promise;
  } finally {
    clearTimeout(firstTimer);
  }
  stage = "baseline-workload";
  workloadStartedAt = new Date().toISOString();
  const workloadClosed = Promise.withResolvers();
  {
    const child = spawn(
      "rtk",
      [
        ...composeArgs,
        "run",
        "--rm",
        "--no-deps",
        "check",
        "node",
        "scripts/check-baseline.mjs",
      ],
      { cwd: root, detached: true, stdio: "inherit" }
    );
    let timedOut = false;
    let failedToStart = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stopProcess(child, "SIGTERM");
    }, baselineTimeoutMs);
    const killTimer = setTimeout(
      () => stopProcess(child, "SIGKILL"),
      baselineTimeoutMs + 5000
    );
    child.once("error", () => {
      failedToStart = true;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      workloadClosed.resolve({ code, failedToStart, signal, timedOut });
    });
  }
  childExit = await workloadClosed.promise;
  workloadFinishedAt = new Date().toISOString();
} catch {
  error = `Host baseline failed at ${stage}; diagnostic text omitted`;
} finally {
  stoppingStats = true;
  if (stats && statsClosed) {
    stopProcess(stats, "SIGTERM");
    const killTimer = setTimeout(() => stopProcess(stats, "SIGKILL"), 3000);
    await statsClosed;
    clearTimeout(killTimer);
  }
}
const peaks = containers.map((container) => {
  const values = samples.filter(
    (sample) => sample.service === container.service
  );
  const measured = values.filter((sample) => sample.memoryBytes !== null);
  const peakBytes = measured.length
    ? Math.max(...measured.map((sample) => sample.memoryBytes))
    : null;
  return {
    containerId: container.id,
    imageId: container.imageId,
    peakMiB:
      peakBytes === null
        ? null
        : Math.round((peakBytes / 1_048_576) * 100) / 100,
    sampleCount: values.length,
    service: container.service,
  };
});
const report = {
  childExit,
  containers,
  error,
  finishedAt: new Date().toISOString(),
  firstSampleTimeoutMs,
  limitations: [
    "Docker stats uses its own update interval; samples are not continuous and can miss short peaks.",
    "Timestamps mark host receipt of each sample, not an atomic snapshot across containers.",
    "Peaks cover the entire one-session and ten-session run plus observer startup; they are not per-phase or per-session peaks.",
    "Container memory includes existing runtime state and Docker accounting; it is not isolated V8 heap usage.",
    "The workload uses a deterministic local provider and does not measure real-provider latency or capacity.",
  ],
  ok:
    !error &&
    childExit?.code === 0 &&
    !childExit.timedOut &&
    samplingErrors.size === 0 &&
    peaks.length === services.length &&
    peaks.every((peak) => peak.sampleCount > 0),
  peaks,
  project,
  samples,
  samplingErrors: [...samplingErrors],
  startedAt,
  statsExit,
  workloadFinishedAt,
  workloadStartedAt,
};
await mkdir(resultsDirectory, { recursive: true });
await writeFile(
  path.join(resultsDirectory, "baseline-memory.json"),
  `${JSON.stringify(report, null, 2)}\n`
);
process.stdout.write(
  `${JSON.stringify({ event: "baseline.memory.complete", ok: report.ok, peaks }, null, 2)}\n`
);
process.exitCode = report.ok ? 0 : 1;
