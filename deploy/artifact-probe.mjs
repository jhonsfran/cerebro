import { readFile } from "node:fs/promises";
import path from "node:path";

import { AwsClient } from "aws4fetch";

const [action, key] = process.argv.slice(2);
if (
  (action !== "write" && action !== "read") ||
  !/^[a-z0-9-]{1,80}$/u.test(key)
) {
  throw new Error("Expected a write or read action and a safe object key");
}
const directory = process.env.CEREBRO_SECRETS_DIR ?? "/run/cerebro-secrets";
const password = await readFile(
  path.join(directory, "minio-password"),
  "utf-8"
);
const aws = new AwsClient({
  accessKeyId: "cerebro",
  region: "us-east-1",
  secretAccessKey: password.trim(),
  service: "s3",
});
const url = `http://minio-artifacts:9000/cerebro-artifacts/${key}`;
const expected = `artifact-${key}`;
if (action === "write") {
  const response = await aws.fetch(url, { body: expected, method: "PUT" });
  if (!response.ok) {
    throw new Error(`Artifact write failed with status ${response.status}`);
  }
} else {
  const response = await aws.fetch(url);
  if (!response.ok || (await response.text()) !== expected) {
    throw new Error("Artifact read did not return the stored content");
  }
}
process.stdout.write(`${expected}\n`);
