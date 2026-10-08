import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { AwsClient } from "aws4fetch";
import postgres from "postgres";

const client = new AwsClient({
  accessKeyId: "runtime",
  region: "us-east-1",
  secretAccessKey: "runtime-local-only-storage-secret",
  service: "s3",
});
const bucket = await client.fetch("http://minio-runtime:9000/cerebro-runtime", {
  method: "PUT",
});
if (!bucket.ok && bucket.status !== 409) {
  throw new Error(`Runtime bucket setup failed with HTTP ${bucket.status}`);
}
const database = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const createAuditTable = async (attempt = 0) => {
  try {
    await database`
      CREATE TABLE IF NOT EXISTS cerebro_audit_event (
        event_id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        occurred_at TIMESTAMP NOT NULL,
        payload JSONB NOT NULL
      )
    `;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "ECONNREFUSED" && error.code !== "57P03") ||
      attempt >= 20
    ) {
      throw error;
    }
    await delay(500);
    await createAuditTable(attempt + 1);
  }
};
try {
  await createAuditTable();
} finally {
  await database.end();
}
const configurationSource = await readFile("wrangler.jsonc", "utf-8");
const configuration = JSON.parse(
  configurationSource.replaceAll(/,\s*(?=[}\]])/gu, "")
);
configuration.vars.FAIL_FIRST_EFFECT =
  process.env.RUNTIME_FAIL_FIRST_EFFECT ?? "0";
configuration.vars.TRACE_NATIVE = process.env.RUNTIME_TRACE_NATIVE ?? "0";
await writeFile("wrangler.jsonc", `${JSON.stringify(configuration)}\n`);
const result = spawnSync(
  "celld",
  [
    "deploy",
    ".",
    "--bucket",
    "s3://cerebro-runtime",
    "--endpoint",
    "http://minio-runtime:9000",
    "--region",
    "us-east-1",
  ],
  { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.status !== 0) {
  throw new Error("Runtime Worker deployment failed");
}
