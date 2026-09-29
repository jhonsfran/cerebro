import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const directory = process.env.CEREBRO_SECRETS_DIR ?? "/run/cerebro-secrets";
const [service] = process.argv.slice(2);
const environment = { ...process.env };
let command;
let args;

if (service === "minio") {
  environment.MINIO_ROOT_USER = "cerebro";
  const password = await readFile(
    path.join(directory, "minio-password"),
    "utf-8"
  );
  environment.MINIO_ROOT_PASSWORD = password.trim();
  command = "minio";
  args = ["server", "/data", "--console-address", ":9001"];
} else if (service === "celld") {
  environment.AWS_ACCESS_KEY_ID = "cerebro";
  const password = await readFile(
    path.join(directory, "minio-password"),
    "utf-8"
  );
  environment.AWS_SECRET_ACCESS_KEY = password.trim();
  environment.AWS_REGION = "us-east-1";
  command = "celld";
  args = [
    "--bucket",
    "s3://cerebro-runtime",
    "--endpoint",
    "http://minio-runtime:9000",
    "--region",
    "us-east-1",
    "--listen",
    "0.0.0.0:8080",
    "--internal-listen",
    "0.0.0.0:8081",
    "--advertise",
    "celld:8081",
  ];
} else {
  throw new Error("Unknown service");
}

const child = spawn(command, args, { env: environment, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
