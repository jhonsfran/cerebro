import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const [mode] = process.argv.slice(2);
const baseURL = process.env.BASE_URL ?? "http://localhost:18765";
const statePath = "/results/migration-state.json";
const evidencePath = "/results/migration-restart-evidence.json";
const kinds = ["current", "pending", "legacy-names"];
const results = [];
const request = async (path, method) => {
  const response = await fetch(`${baseURL}${path}`, {
    method,
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json();
  assert.equal(
    response.status,
    200,
    "Migration endpoint did not return HTTP 200"
  );
  assert.equal(body.ok, true, "Migration endpoint did not pass");
  return body;
};
const record = async (kind, run) => {
  const started = performance.now();
  try {
    const evidence = await run();
    results.push({
      durationMs: Math.round(performance.now() - started),
      evidence,
      id: `migration.${kind}.${mode}`,
      status: "pass",
    });
  } catch {
    results.push({
      durationMs: Math.round(performance.now() - started),
      error: "Migration check failed; response bodies omitted",
      id: `migration.${kind}.${mode}`,
      status: "fail",
    });
  }
};
await mkdir("/results", { recursive: true });
if (mode === "prepare") {
  const cases = [];
  await Promise.all(
    kinds.map(async (kind) => {
      await record(kind, async () => {
        const name = randomUUID();
        const prepared = await request(
          `/control/migration/${name}/prepare?case=${kind}`,
          "POST"
        );
        assert.equal(prepared.kind, kind);
        assert.ok(
          Array.isArray(prepared.markers) && prepared.markers.length > 0
        );
        assert.equal(prepared.bindingNotNull, kind === "pending" ? 1 : 0);
        assert.equal(
          prepared.markerCountAfterPrepare,
          kind === "legacy-names" ? 0 : prepared.markers.length
        );
        cases.push({ kind, name, prepared });
        return { name, ...prepared };
      });
    })
  );
  await writeFile(
    statePath,
    `${JSON.stringify({ cases, version: 1 }, null, 2)}\n`
  );
} else if (mode === "verify") {
  const saved = JSON.parse(await readFile(statePath, "utf-8"));
  assert.equal(saved.version, 1);
  assert.ok(Array.isArray(saved.cases));
  await Promise.all(
    kinds.map(async (kind) => {
      await record(kind, async () => {
        const entry = saved.cases.find((value) => value.kind === kind);
        assert.ok(entry && typeof entry.name === "string");
        const evidence = await request(
          `/control/migration/${encodeURIComponent(entry.name)}/verify`,
          "GET"
        );
        assert.equal(evidence.kind, kind);
        assert.equal(evidence.health.healthy, true);
        assert.equal(evidence.instanceChanged, true);
        assert.equal(evidence.sentinelPreserved, true);
        assert.equal(evidence.markerIdsCorrect, true);
        assert.deepEqual(evidence.beforeMarkers, entry.prepared.markers);
        assert.deepEqual(
          evidence.afterMarkers.map((marker) => marker.id),
          evidence.expectedIds
        );
        if (kind === "pending") {
          assert.equal(evidence.beforeBindingNotNull, 1);
          assert.equal(evidence.bindingNotNull, 0);
          assert.equal(evidence.nullBindingAccepted, true);
          assert.equal(
            evidence.afterMarkers.length,
            entry.prepared.markers.length + 1
          );
        }
        if (kind === "legacy-names") {
          assert.equal(evidence.legacyNamesPreserved, true);
        } else {
          assert.equal(evidence.previousMarkersPreserved, true);
          for (const marker of entry.prepared.markers) {
            assert.deepEqual(
              evidence.afterMarkers.find((after) => after.id === marker.id),
              marker
            );
          }
        }
        return { name: entry.name, ...evidence };
      });
    })
  );
} else {
  throw new Error("Use prepare or verify");
}
const report = {
  mode,
  ok: results.every((result) => result.status === "pass"),
  results,
  timestamp: new Date().toISOString(),
};
await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ mode, ok: report.ok, results: results.map(({ id, status, error }) => ({ error, id, status })) }, null, 2)}\n`
);
process.exitCode = report.ok ? 0 : 1;
