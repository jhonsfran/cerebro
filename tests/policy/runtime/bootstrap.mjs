import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire("/experiment/package.json");
const { AwsClient } = require("aws4fetch");
const versions = {
  "@opencode-ai/plugin": "0.0.0-dev-18697",
  "@opencode-ai/sdk": "0.0.0-dev-18697",
  agents: "0.24.0",
};
await Promise.all(
  Object.entries(versions).map(async ([name, expected]) => {
    const metadata = JSON.parse(
      await readFile(`/experiment/node_modules/${name}/package.json`, "utf-8")
    );
    assert.equal(metadata.version, expected, `Pinned runtime version ${name}`);
  })
);
const version = spawnSync("celld", ["--version"], { encoding: "utf-8" });
assert.equal(version.stdout.trim(), "celld 0.6.0");
const aws = new AwsClient({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  region: "us-east-1",
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  service: "s3",
});
const bucket = await aws.fetch("http://minio:9000/cerebro-s4-runtime", {
  method: "PUT",
});
assert.ok(bucket.ok || bucket.status === 409);
await mkdir("/run/s4/tests/policy/runtime", { recursive: true });
await mkdir("/run/s4/packages", { recursive: true });
await cp(
  "/workspace/tests/policy/runtime/src",
  "/run/s4/tests/policy/runtime/src",
  { recursive: true }
);
await cp("/workspace/tests/policy/fixtures", "/run/s4/tests/policy/fixtures", {
  recursive: true,
});
await Promise.all(
  ["tools", "contracts"].map(async (name) => {
    await rm(`/run/s4/packages/${name}`, { force: true, recursive: true });
    await mkdir(`/run/s4/packages/${name}`, { recursive: true });
    await cp(
      `/workspace/packages/${name}/src`,
      `/run/s4/packages/${name}/src`,
      {
        recursive: true,
      }
    );
    await cp(
      `/workspace/packages/${name}/package.json`,
      `/run/s4/packages/${name}/package.json`
    );
  })
);
try {
  await symlink("/experiment/node_modules", "/run/s4/node_modules");
} catch (error) {
  if (error.code !== "EEXIST") {
    throw error;
  }
}
await mkdir("/experiment/node_modules/@cerebro", { recursive: true });
await Promise.all(
  ["tools", "contracts"].map(async (name) => {
    try {
      await symlink(
        `/run/s4/packages/${name}`,
        `/experiment/node_modules/@cerebro/${name}`
      );
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
  })
);
await writeFile(
  "/run/s4/package.json",
  JSON.stringify({ name: "cerebro-s4-tools-runtime", type: "module" })
);
await writeFile(
  "/run/s4/wrangler.jsonc",
  JSON.stringify({
    compatibility_date: "2026-09-28",
    compatibility_flags: ["nodejs_compat"],
    durable_objects: {
      bindings: [
        { class_name: "ToolsRuntime", name: "RUNTIME" },
        { class_name: "GatewayJournal", name: "GATEWAY_JOURNAL" },
      ],
    },
    main: "tests/policy/runtime/src/worker.ts",
    migrations: [
      { new_sqlite_classes: ["ToolsRuntime", "GatewayJournal"], tag: "v1" },
    ],
    name: "cerebro-s4-tools-runtime",
    services: [
      {
        binding: "GATEWAY",
        entrypoint: "TrustedGateway",
        service: "cerebro-s4-tools-runtime",
      },
    ],
    vars: { FIXTURE_URL: "http://fixture:8090" },
    worker_loaders: [{ binding: "LOADER" }],
  })
);
await writeFile(
  "/run/s4/versions.json",
  JSON.stringify({ celld: version.stdout.trim(), ...versions })
);
const deploy = spawnSync(
  "celld",
  [
    "deploy",
    "/run/s4",
    "--bucket",
    "s3://cerebro-s4-runtime",
    "--endpoint",
    "http://minio:9000",
    "--region",
    "us-east-1",
  ],
  { stdio: "inherit" }
);
if (deploy.error) {
  throw deploy.error;
}
assert.equal(deploy.status, 0, "Actual session 4 tools deployment");
