// Starts, stops, and inspects the local Docker stack.
//
//   node deploy/local.mjs start [--demo]
//   node deploy/local.mjs stop
//   node deploy/local.mjs token [--demo]
//   node deploy/local.mjs logs [--demo] [service...]
//
// --demo adds tests/slice-1/compose.test.yaml: a deterministic fake model and
// connectors, so the app runs without a model key. It uses its own Compose
// project and volumes.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, parseEnv } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { demo: { type: "boolean" } },
});
const [command = "start", ...services] = positionals;
const stacks = {
  demo: {
    files: ["compose.yaml", "tests/slice-1/compose.test.yaml"],
    project: "cerebro-demo",
  },
  local: { files: ["compose.yaml"], project: "cerebro" },
};

const compose = (stack, args, options = {}) =>
  spawnSync(
    "docker",
    [
      "compose",
      "-p",
      stack.project,
      ...stack.files.flatMap((file) => ["-f", file]),
      ...args,
    ],
    { cwd: root, encoding: "utf-8", stdio: "inherit", ...options }
  );
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
// Compose reads .env itself; this only checks that a model is configured.
const environmentFile = () => {
  const file = path.join(root, ".env");
  return existsSync(file) ? parseEnv(readFileSync(file, "utf-8")) : {};
};
const token = (stack) => {
  // `compose run` would create an empty stack, so check that one exists.
  const existing = compose(stack, ["ps", "--all", "--quiet", "secrets-init"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (!existing.stdout?.trim()) {
    fail("Could not read the setup token. Is the stack started?");
  }
  const result = compose(
    stack,
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

const stack = values.demo ? stacks.demo : stacks.local;
switch (command) {
  case "start": {
    if (
      !values.demo &&
      !process.env.CEREBRO_MODEL &&
      !environmentFile().CEREBRO_MODEL
    ) {
      fail(
        "No model is configured. Copy .env.example to .env and set CEREBRO_MODEL, or run pnpm start:demo."
      );
    }
    const started = compose(stack, ["up", "--build", "--detach", "--wait"]);
    if (started.status !== 0) {
      fail(
        `The stack did not start. Run pnpm logs${values.demo ? " --demo" : ""} to see why.`
      );
    }
    const web = process.env.CEREBRO_PUBLIC_WEB_URL ?? "http://localhost:3001";
    process.stdout.write(
      [
        "",
        `Cerebro is running at ${web}`,
        `Setup token: ${token(stack)}`,
        "Sign up, then enter the setup token to become the owner.",
        values.demo
          ? "Demo mode: the model is a fake that gives a fixed answer."
          : "",
        "",
      ].join("\n")
    );
    break;
  }
  case "stop": {
    for (const each of Object.values(stacks)) {
      compose(each, ["stop"]);
    }
    break;
  }
  case "token": {
    process.stdout.write(`${token(stack)}\n`);
    break;
  }
  case "logs": {
    compose(stack, ["logs", "--follow", "--tail=200", ...services]);
    break;
  }
  default: {
    fail(`Unknown command ${command}. Use start, stop, token, or logs.`);
  }
}
