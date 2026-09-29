import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const directory = new URL("../evidence/", import.meta.url);
const artifacts = {
  baseline: "23-baseline.json",
  browser: "19-browser.json",
  historicalHeapFailure: "29-post-load-failure.json",
  lifecycle: "32-lifecycle.json",
  main: "15-final-main.json",
  memory: "24-baseline-memory.json",
  outages: "22-outages.json",
  recovery: "21-recovery.json",
  restart: "25-restart.json",
  tls: "20-private-ca.json",
  validation: "27-validation.json",
};
const readSnapshot = async ([name, artifact]) => {
  try {
    const text = await readFile(new URL(artifact, directory), "utf-8");
    return [
      name,
      {
        artifact,
        data: JSON.parse(text),
        sha256: createHash("sha256").update(text).digest("hex"),
        status: "read",
      },
    ];
  } catch (error) {
    return [
      name,
      {
        artifact,
        status: error.code === "ENOENT" ? "missing" : "invalid",
      },
    ];
  }
};
const sources = Object.fromEntries(
  await Promise.all(Object.entries(artifacts).map(readSnapshot))
);
const issues = [];
const registry = sources.main.data;
const registryResults = Array.isArray(registry?.results)
  ? registry.results
  : [];
if (!Array.isArray(registry?.results) || registryResults.length === 0) {
  issues.push({
    artifact: artifacts.main,
    reason: "The main criterion registry is missing or invalid",
    status: sources.main.status === "missing" ? "not-run" : "fail",
  });
}
const results = new Map();
for (const result of registryResults) {
  if (
    typeof result?.id !== "string" ||
    !["pass", "fail", "not-run"].includes(result.status) ||
    results.has(result.id)
  ) {
    issues.push({
      artifact: artifacts.main,
      reason: "Invalid or duplicate registry criterion",
      status: "fail",
    });
    continue;
  }
  results.set(result.id, { ...result, provenance: [artifacts.main] });
}
for (const source of Object.values(sources)) {
  if (source.status === "invalid") {
    issues.push({
      artifact: source.artifact,
      reason: "Unreadable or invalid JSON snapshot",
      status: "fail",
    });
  }
  if (
    source.artifact !== artifacts.historicalHeapFailure &&
    (source.data?.ok === false ||
      (Array.isArray(source.data?.results) &&
        source.data.results.some((item) => item?.status === "fail")))
  ) {
    issues.push({
      artifact: source.artifact,
      reason: "Snapshot records a failed check",
      status: "fail",
    });
  }
}
const merge = (id, names, predicate, scope) => {
  const previous = results.get(id);
  if (!previous) {
    issues.push({
      artifact: artifacts.main,
      reason: `Missing registry criterion: ${id}`,
      status: "fail",
    });
    return;
  }
  const selected = names.map((name) => sources[name]);
  let status = "not-run";
  if (selected.some((source) => source.status === "invalid")) {
    status = "fail";
  } else if (selected.every((source) => source.status === "read")) {
    try {
      status =
        predicate(...selected.map((source) => source.data)) === true
          ? "pass"
          : "fail";
    } catch {
      status = "fail";
    }
  }
  if (previous.status === "fail") {
    status = "fail";
  }
  results.set(id, {
    ...previous,
    provenance: [artifacts.main, ...selected.map((source) => source.artifact)],
    reason:
      status === "not-run"
        ? "A selected evidence snapshot is missing"
        : undefined,
    registryResult: registryResults.find((result) => result.id === id),
    scope,
    status,
  });
};
merge(
  "auth.browser",
  ["browser"],
  (report) =>
    report.ok === true &&
    report.crossOrigin === true &&
    report.credentials === "include" &&
    report.origin !== report.api &&
    [report.signup, report.login, report.session, report.logout].every(
      (status) => status === 200
    ) &&
    report.initialLogout === 200 &&
    report.beforeLogin === 401 &&
    report.afterLogout === 401,
  "Credentialed browser signup, login, session read, and logout across local origins"
);
merge(
  "database.private-ca",
  ["tls"],
  (report) =>
    report.nodeVerifiedPrivateCa?.ssl === true &&
    typeof report.nodeVerifiedPrivateCa.version === "string" &&
    report.nodeVerifiedPrivateCa.version.startsWith("TLS") &&
    report.worker?.rawSocket?.accepted === false &&
    report.worker.rawSocket.failure === "unknown-issuer" &&
    report.worker.driverWithPrivateCa?.accepted === false &&
    report.worker.driverWithPrivateCa.failure === "unknown-issuer",
  "Private CA limitation reproduced with a successful Node TLS control; no positive Worker TLS proof"
);
const recoveryIds = [
  "recovery.before-model",
  "recovery.approval",
  "recovery.idempotent-effect",
  "recovery.unknown-effect",
  "recovery.completed",
];
const uniqueResult = (report, id) => {
  const matches = report?.results?.filter((result) => result.id === id);
  return matches?.length === 1 ? matches[0] : undefined;
};
for (const id of recoveryIds) {
  merge(
    id,
    ["recovery"],
    (report) => uniqueResult(report, id)?.status === "pass",
    "Controlled provider, one logical effect per recovery object, SIGKILL restart checks"
  );
}
merge(
  "recovery.wakeup",
  ["recovery"],
  (report) => {
    const before = uniqueResult(report, "recovery.before-model");
    const evidence = before?.evidence;
    const phases = evidence?.wake?.phases;
    const accepted = phases?.find((phase) => phase.phase === "accepted");
    return (
      before?.status === "pass" &&
      evidence?.noSessionRequestBeforeWake === true &&
      evidence.wake.operationId === evidence.id &&
      typeof accepted?.instance === "string" &&
      Number.isFinite(accepted.at) &&
      phases.some(
        (phase) =>
          phase.phase === "waiting-for-approval" &&
          typeof phase.instance === "string" &&
          phase.instance !== accepted.instance &&
          phase.at > accepted.at
      )
    );
  },
  "A new instance reaches approval after restart before another Session request"
);
for (const id of ["recovery.postgres-outage", "recovery.minio-outage"]) {
  merge(
    id,
    ["outages"],
    (report) => uniqueResult(report, id)?.status === "pass",
    "Controlled service outage with preserved state and retry assertions"
  );
}
for (const [id, concurrency] of [
  ["baseline.one-session", 1],
  ["baseline.ten-sessions", 10],
]) {
  merge(
    id,
    ["baseline", "memory"],
    (baseline, memory) => {
      const phases = baseline.phases?.filter((phase) => phase.id === id);
      const phase = phases?.length === 1 ? phases[0] : undefined;
      return (
        baseline.ok === true &&
        memory.ok === true &&
        phase?.status === "pass" &&
        phase.concurrency === concurrency &&
        phase.uniqueSessions === concurrency &&
        phase.requests?.length === concurrency &&
        phase.requests.every((request) => request.status === "pass") &&
        phase.postgres?.samples?.length > 0 &&
        ["celld", "postgres", "fixture"].every((service) =>
          memory.peaks?.some(
            (peak) =>
              peak.service === service &&
              peak.sampleCount > 0 &&
              Number.isFinite(peak.peakMiB)
          )
        )
      );
    },
    "Deterministic fixture latency and PostgreSQL samples; memory peaks cover the whole container and combined run"
  );
}
merge(
  "database.restart",
  ["restart"],
  (report) =>
    report.committedRowPreserved === true && report.rollbackAbsent === true,
  "Ordinary service restart preserves committed PostgreSQL data"
);
merge(
  "auth.restart",
  ["restart"],
  (report) => report.authSessionPreserved === true,
  "Existing authentication session survives ordinary service restart"
);
merge(
  "deployment.clean-rebuild",
  ["validation"],
  (report) =>
    report.freshVolumes === true &&
    report.startupExit === 0 &&
    typeof report.imageIds?.celld === "string" &&
    report.imageIds.celld.startsWith("sha256:") &&
    typeof report.imageIds?.check === "string" &&
    report.imageIds.check.startsWith("sha256:"),
  "Selected fresh-volume startup and image identity record; cached build layers may be reused"
);
for (const [id, reason] of [
  ["agent.real-provider", "No selected real-provider runtime evidence"],
  [
    "database.tls-verified",
    "No selected successful Worker connection to publicly trusted TLS PostgreSQL",
  ],
]) {
  const previous = results.get(id);
  if (previous) {
    results.set(id, {
      ...previous,
      reason,
      status: previous.status === "fail" ? "fail" : "not-run",
    });
  } else {
    issues.push({
      artifact: artifacts.main,
      reason: `Missing registry criterion: ${id}`,
      status: "fail",
    });
  }
}
const { lifecycle } = sources;
const validLifecycleCensus = (limits, census) =>
  limits?.idleMs === 120_000 &&
  limits.maxOngoingRequests === 0 &&
  limits.maxRetiringIsolates === 0 &&
  Number.isFinite(census?.idleMs) &&
  census.idleMs >= 0 &&
  census.idleMs <= limits.idleMs &&
  census.ongoingRequests === 0 &&
  census.retiringIsolates === 0;
const validLifecycle = (snapshot) => {
  const limits = snapshot?.limits;
  const census = snapshot?.finalCensus;
  return (
    snapshot?.ok === true &&
    typeof snapshot.imageId === "string" &&
    snapshot.imageId.startsWith("sha256:") &&
    typeof snapshot.workerVersion === "string" &&
    snapshot.workerVersion.length > 0 &&
    snapshot.stableVersion === true &&
    snapshot.noDeploymentReset === true &&
    snapshot.historicalFailureArtifact === artifacts.historicalHeapFailure &&
    Number.isInteger(limits?.minimumRepetitions) &&
    limits.minimumRepetitions >= 2 &&
    validLifecycleCensus(limits, census) &&
    Array.isArray(snapshot.repetitions) &&
    snapshot.repetitions.length >= limits.minimumRepetitions &&
    snapshot.repetitions.every(
      (repetition) =>
        repetition?.mainPass === 25 &&
        repetition.mainFail === 0 &&
        repetition.baselineOk === true
    )
  );
};
let lifecycleStatus = "not-run";
if (lifecycle.status === "invalid") {
  lifecycleStatus = "fail";
} else if (lifecycle.status === "read") {
  lifecycleStatus = validLifecycle(lifecycle.data) ? "pass" : "fail";
}
results.set("runtime.lifecycle", {
  id: "runtime.lifecycle",
  provenance: [artifacts.lifecycle, artifacts.historicalHeapFailure],
  reason:
    lifecycleStatus === "not-run"
      ? "The selected lifecycle snapshot is missing"
      : undefined,
  runtime:
    lifecycle.status === "read"
      ? {
          imageId: lifecycle.data?.imageId,
          workerVersion: lifecycle.data?.workerVersion,
        }
      : undefined,
  scope:
    "At least two main-check and baseline repetitions on one fixed version without a deployment reset; zero ongoing requests and retiring isolates within 120 seconds of idle observation",
  status: lifecycleStatus,
});
const historicalFailure = {
  artifact: artifacts.historicalHeapFailure,
  sourceStatus: sources.historicalHeapFailure.status,
  status:
    lifecycleStatus === "pass" &&
    sources.historicalHeapFailure.status === "read"
      ? "superseded"
      : "unresolved",
  supersededBy: lifecycleStatus === "pass" ? artifacts.lifecycle : undefined,
};
if (historicalFailure.status !== "superseded") {
  issues.push({
    artifact: artifacts.historicalHeapFailure,
    reason:
      "The historical post-load heap failure has not been superseded by passing lifecycle evidence",
    status: "fail",
  });
}
const entries = [...results.values()];
const counts = { fail: 0, "not-run": 0, pass: 0 };
for (const result of entries) {
  counts[result.status] += 1;
}
let gate = "incomplete";
if (counts.fail > 0 || issues.some((issue) => issue.status === "fail")) {
  gate = "fail";
} else if (
  entries.length > 0 &&
  counts["not-run"] === 0 &&
  issues.length === 0
) {
  gate = "pass";
}
const report = {
  counts,
  gate,
  historicalFailures: [historicalFailure],
  issues,
  kind: "selected-evidence-snapshot-summary",
  limitations: [
    "This script summarizes selected committed artifacts. It does not run runtime checks.",
    "Each criterion retains its source artifact. Different checks can have different recorded image IDs.",
    "A fixture pass does not establish real-provider compatibility or production capacity.",
    "The seven previously observed requests can remain until the 60-second AbortSignal timeout and isolate reaper complete; lifecycle success requires the observed final census to drain.",
    "The lifecycle check covers the recorded repetitions and idle window, not long-term capacity.",
  ],
  registryMetadata: registry
    ? Object.fromEntries(
        Object.entries(registry).filter(([key]) => key !== "results")
      )
    : null,
  results: entries,
  sources: Object.values(sources).map(({ artifact, sha256, status }) => ({
    artifact,
    sha256,
    status,
  })),
  timestamp: new Date().toISOString(),
};
await writeFile(
  new URL("28-session-zero-status.json", directory),
  `${JSON.stringify(report, null, 2)}\n`
);
process.stdout.write(`${JSON.stringify({ counts, gate, issues }, null, 2)}\n`);
process.exitCode = gate === "pass" ? 0 : 1;
