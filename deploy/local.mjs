// Starts, stops, and inspects the local Docker stack.
//
//   node deploy/local.mjs start
//   node deploy/local.mjs stop
//   node deploy/local.mjs token
//   node deploy/local.mjs logs [service...]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, parseEnv } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const { positionals } = parseArgs({ allowPositionals: true });
const [command = "start", ...services] = positionals;

const compose = (args, options = {}) =>
  spawnSync(
    "docker",
    ["compose", "-p", "cerebro", "-f", "compose.yaml", ...args],
    {
      cwd: root,
      encoding: "utf-8",
      stdio: "inherit",
      ...options,
    }
  );
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
// Compose reads .env itself. This only reads it to check the model settings.
const setting = (name) => {
  const file = path.join(root, ".env");
  const values = existsSync(file) ? parseEnv(readFileSync(file, "utf-8")) : {};
  return (process.env[name] ?? values[name])?.trim();
};
const token = () => {
  // `compose run` would create an empty stack, so check that one exists.
  const existing = compose(["ps", "--all", "--quiet", "secrets-init"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (!existing.stdout?.trim()) {
    fail("Could not read the setup token. Is the stack started?");
  }
  const result = compose(
    [
      "run",
      "--rm",
      "--no-deps",
      "bootstrap",
      "node",
      "--input-type=module",
      "-e",
      'import {readFile} from "node:fs/promises";process.stdout.write(await readFile("/run/cerebro-secrets/bootstrap-token","utf8"))',
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  if (result.status !== 0) {
    fail("Could not read the setup token. Is the stack started?");
  }
  return result.stdout.trim();
};

switch (command) {
  case "start": {
    // The default model is on OpenRouter and needs a key. A custom endpoint,
    // such as a local Ollama server, may not.
    if (
      !setting("CEREBRO_MODEL_API_KEY") &&
      !setting("CEREBRO_MODEL_BASE_URL")
    ) {
      fail(
        "No model key is configured. Copy .env.example to .env and set CEREBRO_MODEL_API_KEY."
      );
    }
    const started = compose(["up", "--build", "--detach", "--wait"]);
    if (started.status !== 0) {
      fail("The stack did not start. Run pnpm logs to see why.");
    }
    const web = setting("CEREBRO_PUBLIC_WEB_URL") || "http://localhost:3001";
    process.stdout.write(
      [
        "",
        `Cerebro is running at ${web}`,
        `Setup token: ${token()}`,
        "Sign up, then enter the setup token to become the owner.",
        "",
      ].join("\n")
    );
    break;
  }
  case "stop": {
    compose(["stop"]);
    break;
  }
  case "token": {
    process.stdout.write(`${token()}\n`);
    break;
  }
  case "logs": {
    compose(["logs", "--follow", "--tail=200", ...services]);
    break;
  }
  default: {
    fail(`Unknown command ${command}. Use start, stop, token, or logs.`);
  }
}
