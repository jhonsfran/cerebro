import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const commands = new Set(["info", "peek", "redrive"]);
const queues = new Map([
  ["cerebro-slack-events", "source"],
  ["cerebro-slack-events-dead-letter", "dead-letter"],
  ["cerebro-team-commands", "source"],
  ["cerebro-team-commands-dead-letter", "dead-letter"],
  ["cerebro-team-reports", "source"],
  ["cerebro-team-reports-dead-letter", "dead-letter"],
]);
const usage =
  "Use info QUEUE, peek QUEUE [--limit N], or redrive DEAD_LETTER_QUEUE --limit N. Limits are 1 through 100.";
const redact = (output, secret) =>
  output
    .replaceAll(JSON.stringify(secret).slice(1, -1), "[secret removed]")
    .replaceAll(secret, "[secret removed]");
const argumentsFor = (values) => {
  const [command, queue, flag, value] = values;
  if (!commands.has(command) || !queues.has(queue)) {
    throw new Error(usage);
  }
  if (command === "redrive" && queues.get(queue) !== "dead-letter") {
    throw new Error(usage);
  }
  if (command === "info") {
    if (values.length !== 2) {
      throw new Error(usage);
    }
    return ["queue", command, queue];
  }
  if (command === "peek" && values.length === 2) {
    return ["queue", command, queue, "--limit", "10"];
  }
  if (
    values.length !== 4 ||
    flag !== "--limit" ||
    !/^[1-9]\d*$/u.test(value) ||
    Number(value) > 100
  ) {
    throw new Error(usage);
  }
  return ["queue", command, queue, "--limit", String(Number(value))];
};
const main = async () => {
  const args = argumentsFor(process.argv.slice(2));
  const directory = process.env.CEREBRO_SECRETS_DIR ?? "/run/cerebro-secrets";
  let password;
  try {
    const contents = await readFile(
      path.join(directory, "minio-password"),
      "utf-8"
    );
    password = contents.trim();
    if (password.length < 32 || password.includes("\0")) {
      throw new Error("Invalid fleet credential");
    }
  } catch {
    throw new Error("Could not read valid fleet credentials.");
  }
  let result;
  try {
    result = spawnSync(
      "celld",
      [
        ...args,
        "--bucket",
        "s3://cerebro-runtime",
        "--endpoint",
        "http://minio-runtime:9000",
        "--region",
        "us-east-1",
        "--json",
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: "cerebro",
          AWS_REGION: "us-east-1",
          AWS_SECRET_ACCESS_KEY: password,
          AWS_SESSION_TOKEN: undefined,
        },
        maxBuffer: 32 * 1024 * 1024,
        shell: false,
        timeout: 30_000,
      }
    );
  } catch {
    throw new Error("The celld queue command could not start.");
  }
  process.stdout.write(redact(result.stdout ?? "", password));
  process.stderr.write(redact(result.stderr ?? "", password));
  if (result.error || result.signal) {
    throw new Error("The celld queue command did not complete.");
  }
  process.exitCode = result.status ?? 1;
};

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
