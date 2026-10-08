import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire("/runtime/package.json");
const { AwsClient } = require("aws4fetch");
const manifest = JSON.parse(
  await readFile("/workspace/tests/runtime/package.json", "utf-8")
);
const versions = { node: process.version };
const installed = await Promise.all(
  [
    "agents",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-durable",
    "effect",
  ].map(async (name) => {
    const metadata = JSON.parse(
      await readFile(`/runtime/node_modules/${name}/package.json`, "utf-8")
    );
    assert.equal(
      metadata.version,
      manifest.dependencies[name],
      `Selected runtime version ${name}`
    );
    return [name, metadata.version];
  })
);
for (const [name, installedVersion] of installed) {
  versions[name] = installedVersion;
}
const version = spawnSync("celld", ["--version"], { encoding: "utf-8" });
const dockerfile = await readFile(
  "/workspace/tests/runtime/Dockerfile",
  "utf-8"
);
const selectedCelld =
  /FROM ghcr\.io\/denoland\/celld:(?<version>[\d.]+)@/u.exec(dockerfile)?.groups
    ?.version;
assert.equal(version.stdout.trim(), `celld ${selectedCelld}`);
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
  ["tools", "contracts", "runtime", "db"].map(async (name) => {
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
  await symlink("/runtime/node_modules", "/run/s4/node_modules");
} catch (error) {
  if (error.code !== "EEXIST") {
    throw error;
  }
}
await mkdir("/runtime/node_modules/@cerebro", { recursive: true });
await Promise.all(
  ["tools", "contracts", "runtime", "db"].map(async (name) => {
    try {
      await symlink(
        `/run/s4/packages/${name}`,
        `/runtime/node_modules/@cerebro/${name}`
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
  JSON.stringify({
    celld: version.stdout.trim(),
    sourceIdentity: process.env.POLICY_SOURCE_ID,
    ...versions,
  })
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
assert.equal(deploy.status, 0, "Actual native policy tools deployment");
