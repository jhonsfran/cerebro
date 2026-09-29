import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AwsClient } from "aws4fetch";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const project = `cerebro-memory-${randomUUID().slice(0, 8)}`;
const environment = {
  ...process.env,
  MEMORY_TEST_SECRET: randomUUID(),
};
const composeArguments = [
  "compose",
  "-f",
  "tests/memory/compose.yaml",
  "-p",
  project,
];

const execute = promisify(execFile);
const run = async (command, args, env, capture = false) => {
  try {
    const { stdout, stderr } = await execute(command, args, {
      env,
      maxBuffer: 10 * 1024 * 1024,
    });
    process.stderr.write(stderr);
    if (!capture) {
      process.stdout.write(stdout);
    }
    return stdout.trim();
  } catch (error) {
    process.stderr.write(error.stderr ?? "");
    process.stdout.write(error.stdout ?? "");
    throw new Error(`${command} failed with exit code ${error.code}.`, {
      cause: error,
    });
  }
};

try {
  await run(
    "docker",
    [...composeArguments, "up", "--build", "-d", "--wait"],
    environment
  );
  const databaseAddress = await run(
    "docker",
    [...composeArguments, "port", "postgres", "5432"],
    environment,
    true
  );
  const artifactAddress = await run(
    "docker",
    [...composeArguments, "port", "minio", "9000"],
    environment,
    true
  );
  const databaseUrl = `postgres://cerebro:${environment.MEMORY_TEST_SECRET}@${databaseAddress}/memory_test`;
  const client = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(
        new URL("../../packages/db/src/migrations", import.meta.url)
      ),
    });
  } finally {
    await client.end({ timeout: 2 });
  }
  const endpoint = `http://${artifactAddress}`;
  const aws = new AwsClient({
    accessKeyId: "memory-test",
    region: "us-east-1",
    secretAccessKey: environment.MEMORY_TEST_SECRET,
    service: "s3",
  });
  const bucketResponse = await aws.fetch(`${endpoint}/memory-test`, {
    method: "PUT",
  });
  if (!bucketResponse.ok) {
    throw new Error(
      `Memory test bucket creation failed with status ${bucketResponse.status}`
    );
  }
  await run("bun", ["test", "tests/memory"], {
    ...environment,
    MEMORY_TEST_ARTIFACT_ACCESS_KEY_ID: "memory-test",
    MEMORY_TEST_ARTIFACT_BUCKET: "memory-test",
    MEMORY_TEST_ARTIFACT_ENDPOINT: endpoint,
    MEMORY_TEST_ARTIFACT_SECRET_ACCESS_KEY: environment.MEMORY_TEST_SECRET,
    MEMORY_TEST_DATABASE_URL: databaseUrl,
  });
} finally {
  await run(
    "docker",
    [...composeArguments, "down", "--volumes", "--remove-orphans"],
    environment
  );
}
