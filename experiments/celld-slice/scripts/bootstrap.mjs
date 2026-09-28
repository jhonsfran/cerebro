import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { AwsClient } from "aws4fetch";
import postgres from "postgres";

const aws = new AwsClient({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  region: "us-east-1",
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  service: "s3",
});
await Promise.all(
  [
    ["minio-runtime", "cerebro-runtime"],
    ["minio-artifacts", "cerebro-artifacts"],
  ].map(async ([host, bucket]) => {
    const response = await aws.fetch(`http://${host}:9000/${bucket}`, {
      method: "PUT",
    });
    const body = await response.text();
    if (
      !response.ok &&
      !(response.status === 409 && body.includes("BucketAlreadyOwnedByYou"))
    ) {
      throw new Error(
        `Bucket initialization failed at ${host} with status ${response.status}`
      );
    }
  })
);
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  await sql.unsafe(
    await readFile(new URL("schema.sql", import.meta.url), "utf-8")
  );
} finally {
  await sql.end();
}
const deployment = spawnSync(
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
  { stdio: "inherit" }
);
if (deployment.error) {
  throw deployment.error;
}
process.exitCode = deployment.status ?? 1;
