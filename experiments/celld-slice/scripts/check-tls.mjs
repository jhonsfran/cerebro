import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

const directory = process.env.TLS_FIXTURE_DIR ?? "/results/tls";
const ca = await readFile(path.join(directory, "ca.crt"), "utf-8");
const client = postgres(
  "postgres://slice:slice-local-only@postgres-tls:5432/slice",
  {
    connect_timeout: 5,
    idle_timeout: 1,
    max: 1,
    prepare: false,
    ssl: { ca, rejectUnauthorized: true },
  }
);
let control;
try {
  const rows =
    await client`select ssl, version, cipher from pg_stat_ssl where pid = pg_backend_pid()`;
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.ssl, true);
  control = row;
} finally {
  await client.end({ timeout: 1 });
}
const evidence = {
  caSha256: createHash("sha256").update(ca).digest("hex"),
  nodeVerifiedPrivateCa: control,
  worker: null,
};
if (!process.argv.includes("--control-only")) {
  const base = process.env.BASE_URL ?? "http://celld:8080";
  const response = await fetch(`${base}/database/tls`, {
    body: ca,
    headers: { "Content-Type": "application/x-pem-file" },
    method: "POST",
    signal: AbortSignal.timeout(25_000),
  });
  assert.equal(
    response.status,
    200,
    "Worker TLS probe did not return observations"
  );
  const worker = await response.json();
  assert.equal(worker.rawSocket.accepted, false);
  assert.equal(
    worker.rawSocket.failure,
    "unknown-issuer",
    "Private-CA failure must be a certificate trust error"
  );
  assert.equal(worker.driverWithPrivateCa.accepted, false);
  assert.equal(worker.driverWithPrivateCa.failure, "unknown-issuer");
  evidence.worker = worker;
}
const output = process.env.RESULTS_DIR ?? "/results";
await mkdir(output, { recursive: true });
await writeFile(
  path.join(output, "tls-evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`
);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
