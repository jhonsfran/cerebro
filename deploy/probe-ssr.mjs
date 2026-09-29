import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { AwsClient } from "aws4fetch";

const directory = process.env.CEREBRO_SECRETS_DIR ?? "/run/cerebro-secrets";
const passwordFile = await readFile(
  path.join(directory, "minio-password"),
  "utf-8"
);
const password = passwordFile.trim();
const environment = {
  ...process.env,
  AWS_ACCESS_KEY_ID: "cerebro",
  AWS_REGION: "us-east-1",
  AWS_SECRET_ACCESS_KEY: password,
  CELLD_DURABILITY: "bucket",
  CELLD_TELEMETRY: "0",
};
const bucket = "cerebro-web-probe";
const aws = new AwsClient({
  accessKeyId: "cerebro",
  region: "us-east-1",
  secretAccessKey: password,
  service: "s3",
});
const bucketResponse = await aws.fetch(`http://minio-runtime:9000/${bucket}`, {
  method: "PUT",
});
if (bucketResponse.status !== 200 && bucketResponse.status !== 409) {
  throw new Error(
    `SSR probe bucket creation failed with ${bucketResponse.status}`
  );
}

const configPath = path.join(process.cwd(), "wrangler.jsonc");
const config = {
  compatibility_date: "2026-09-28",
  compatibility_flags: ["nodejs_compat"],
  main: "apps/web/dist/server/server.js",
  name: "cerebro-web-probe",
};
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
});
let deployment;
try {
  deployment = spawnSync(
    "celld",
    [
      "deploy",
      ".",
      "--bucket",
      `s3://${bucket}`,
      "--endpoint",
      "http://minio-runtime:9000",
      "--region",
      "us-east-1",
    ],
    { encoding: "utf-8", env: environment, maxBuffer: 10 * 1024 * 1024 }
  );
} finally {
  await unlink(configPath);
}
const deployOutput =
  `${deployment.stdout ?? ""}${deployment.stderr ?? ""}`.replaceAll(
    password,
    "[secret removed]"
  );
if (deployment.status !== 0) {
  process.stdout.write(
    `${JSON.stringify({ output: deployOutput.slice(-6000), stage: "deploy", status: "failed" })}\n`
  );
  process.exit(0);
}

const runtime = spawn(
  "celld",
  [
    "--bucket",
    `s3://${bucket}`,
    "--endpoint",
    "http://minio-runtime:9000",
    "--region",
    "us-east-1",
    "--listen",
    "127.0.0.1:8084",
    "--internal-listen",
    "127.0.0.1:8085",
    "--advertise",
    "127.0.0.1:8085",
  ],
  { env: environment, stdio: ["ignore", "pipe", "pipe"] }
);
let runtimeLog = "";
const appendLog = (chunk) => {
  runtimeLog = `${runtimeLog}${chunk}`.slice(-6000);
};
runtime.stdout.on("data", appendLog);
runtime.stderr.on("data", appendLog);
const requestWeb = async (remaining) => {
  if (remaining === 0) {
    return { stage: "runtime", status: "unavailable" };
  }
  try {
    const response = await fetch("http://127.0.0.1:8084/", {
      signal: AbortSignal.timeout(2000),
    });
    const body = await response.text();
    return {
      body: body.slice(0, 1000),
      stage: "runtime",
      status: response.status,
    };
  } catch {
    await setTimeout(500);
    return requestWeb(remaining - 1);
  }
};
let result;
try {
  result = await requestWeb(30);
} finally {
  if (runtime.exitCode === null) {
    runtime.kill("SIGTERM");
    await once(runtime, "exit");
  }
}
process.stdout.write(
  `${JSON.stringify({ ...result, log: runtimeLog.replaceAll(password, "[secret removed]") })}\n`
);
