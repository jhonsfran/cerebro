import { execFile, spawn } from "node:child_process";
/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Readiness and crash polling are ordered and bounded. */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";

import { boundaries } from "./provider.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    "api-port": { default: "28765", type: "string" },
    down: { type: "boolean" },
    "dry-run": { type: "boolean" },
    "fixture-only": { type: "boolean" },
    "fixture-port": { default: "28090", type: "string" },
    "kill-at": { type: "string" },
    "no-build": { type: "boolean" },
    project: { type: "string" },
    "state-sha": { type: "string" },
    "web-port": { default: "4001", type: "string" },
  },
});
if (!/^cerebro-s1-[a-z0-9][a-z0-9_-]*$/u.test(values.project ?? "")) {
  throw new Error("Use a dedicated --project cerebro-s1-NAME");
}
const ports = ["api-port", "web-port", "fixture-port"].map((name) => {
  const value = values[name];
  if (!/^\d+$/u.test(value) || Number(value) < 1024 || Number(value) > 65_535) {
    throw new Error(`Invalid ${name}`);
  }
  return Number(value);
});
if (new Set(ports).size !== ports.length) {
  throw new Error("Ports must be distinct");
}
if (values["kill-at"] && !boundaries.includes(values["kill-at"])) {
  throw new Error("Unknown crash boundary");
}
const [apiPort, webPort, fixturePort] = ports;
const sha = (
  await execute("git", ["rev-parse", "HEAD"], { cwd: root })
).stdout.trim();
if (values["state-sha"] && !/^[a-f0-9]{40}$/u.test(values["state-sha"])) {
  throw new Error("Invalid state SHA");
}
const directory = path.join(
  root,
  "artifacts/slice-1",
  values["state-sha"] ?? sha,
  values.project
);
const overridePath = path.join(directory, "compose.fixture.json");
const env = {
  ...process.env,
  CEREBRO_API_PORT: String(apiPort),
  CEREBRO_DEPLOY_MODE: "fixture",
  CEREBRO_FIXTURE_ID: values.project,
  CEREBRO_FIXTURE_PORT: String(fixturePort),
  CEREBRO_FIXTURE_SHA: sha,
  CEREBRO_PUBLIC_API_URL: `http://localhost:${apiPort}`,
  CEREBRO_PUBLIC_WEB_URL: `http://localhost:${webPort}`,
  CEREBRO_WEB_PORT: String(webPort),
  COMPOSE_PROFILES: "fixture",
};
const compose = [
  "compose",
  "--project-directory",
  root,
  "-p",
  values.project,
  "-f",
  path.join(root, "compose.yaml"),
  "-f",
  overridePath,
];
const docker = async (args) =>
  (
    await execute("docker", args, {
      cwd: root,
      env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    })
  ).stdout;
const containers = async () => {
  const ids = (
    await docker([
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${values.project}`,
    ])
  ).trim();
  return ids ? JSON.parse(await docker(["inspect", ...ids.split("\n")])) : [];
};
const assertOwned = async () => {
  const items = await containers();
  if (
    items.some((item) => item.Config.Labels["cerebro.slice-1"] !== "disposable")
  ) {
    throw new Error(
      "Project contains containers not owned by this fixture boot"
    );
  }
  const volumeIds = (
    await docker([
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${values.project}`,
    ])
  ).trim();
  if (volumeIds) {
    const volumes = JSON.parse(
      await docker(["volume", "inspect", ...volumeIds.split("\n")])
    );
    if (
      volumes.some(
        (volume) => volume.Labels["cerebro.slice-1"] !== "disposable"
      )
    ) {
      throw new Error("Project contains protected volumes");
    }
  }
  return items;
};
if (values.down || values["kill-at"]) {
  await readFile(overridePath);
  const owned = await assertOwned();
  if (values.down) {
    await docker([...compose, "down", "--volumes"]);
    process.stdout.write(
      `Removed only ${values.project} fixture containers and volumes\n`
    );
  } else {
    const target = owned.find(
      (item) => item.Config.Labels["com.docker.compose.service"] === "celld"
    );
    if (!target) {
      throw new Error("The fixture project has no celld process to kill");
    }
    const fixtureUrl = `http://localhost:${fixturePort}`;
    const armId = randomUUID();
    const control = await fetch(`${fixtureUrl}/control`, {
      body: JSON.stringify({ arm: { boundary: values["kill-at"], id: armId } }),
      headers: {
        "Content-Type": "application/json",
        "X-Fixture-Control": "slice-1-control",
      },
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    if (!control.ok) {
      throw new Error("Could not arm checkpoint");
    }
    let observed;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const response = await fetch(`${fixtureUrl}/observations`, {
        signal: AbortSignal.timeout(5000),
      });
      observed = await response.json();
      if (
        observed.checkpoints.some(
          (entry) =>
            entry.boundary === values["kill-at"] && entry.armId === armId
        )
      ) {
        break;
      }
      await delay(100);
    }
    if (
      !observed?.checkpoints.some(
        (entry) => entry.boundary === values["kill-at"] && entry.armId === armId
      )
    ) {
      throw new Error(
        "Checkpoint not reached in 60 seconds; host left running"
      );
    }
    await docker(["kill", "--signal", "KILL", target.Id]);
    await writeFile(
      path.join(directory, `crash-${values["kill-at"]}.json`),
      `${JSON.stringify({ at: Date.now(), boundary: values["kill-at"], fixtureId: values.project, killedContainer: target.Id, observed, sha }, null, 2)}\n`
    );
    process.stdout.write(
      `Killed only fixture celld at ${values["kill-at"]}; use Compose start celld for recovery\n`
    );
  }
} else {
  if ((await containers()).length) {
    throw new Error("Project already exists; choose a fresh fixture project");
  }
  await mkdir(directory, { recursive: true });
  const configuration = JSON.parse(
    await docker([
      "compose",
      "--profile",
      "fixture",
      "-p",
      values.project,
      "-f",
      path.join(root, "compose.yaml"),
      "config",
      "--format",
      "json",
    ])
  );
  for (const volume of Object.values(configuration.volumes)) {
    if (volume.external || !volume.name.startsWith(`${values.project}_`)) {
      throw new Error("Fixture requires project-owned volumes");
    }
    const existing = (
      await docker(["volume", "ls", "-q", "--filter", `name=^${volume.name}$`])
    ).trim();
    if (existing) {
      throw new Error(
        "Project has existing volumes; choose a fresh fixture project"
      );
    }
  }
  const services = Object.fromEntries(
    Object.keys(configuration.services).map((name) => [
      name,
      { labels: { "cerebro.slice-1": "disposable" } },
    ])
  );
  const volumes = Object.fromEntries(
    Object.keys(configuration.volumes).map((name) => [
      name,
      { labels: { "cerebro.slice-1": "disposable" } },
    ])
  );
  // Cloud builds may opt into the public CA without copying it into image layers.
  if (process.env.CODEX_PROXY_CERT) {
    for (const name of [
      "bootstrap",
      "secrets-init",
      "celld",
      "web",
      "minio-runtime",
      "minio-artifacts",
    ]) {
      services[name].build = { secrets: ["proxy_ca"] };
    }
  }
  const secrets = process.env.CODEX_PROXY_CERT
    ? { proxy_ca: { file: process.env.CODEX_PROXY_CERT } }
    : {};
  await writeFile(
    overridePath,
    `${JSON.stringify({ secrets, services, volumes }, null, 2)}\n`
  );
  if (values["dry-run"]) {
    await docker([...compose, "config", "--quiet"]);
    process.stdout.write(`Validated isolated project ${values.project}\n`);
  } else {
    const args = [
      ...compose,
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "180",
      ...(values["no-build"] ? [] : ["--build"]),
      ...(values["fixture-only"] ? ["fixture"] : []),
    ];
    const child = spawn("docker", args, { cwd: root, env, stdio: "inherit" });
    const [code] = await once(child, "exit");
    if (code !== 0) {
      throw new Error(
        `Fixture boot failed; project ${values.project} retained for diagnosis`
      );
    }
    const items = await assertOwned();
    const report = {
      apiUrl: values["fixture-only"] ? null : env.CEREBRO_PUBLIC_API_URL,
      fixtureId: values.project,
      fixtureUrl: `http://localhost:${fixturePort}`,
      hostImage:
        "ghcr.io/denoland/celld:0.6.1@sha256:acb0bc2dca628f0dac7c6b43eea42615a79f4943f316f6df7c1da0b86d52150b",
      images: items.map((item) => ({
        id: item.Image,
        service: item.Config.Labels["com.docker.compose.service"],
      })),
      mode: values["fixture-only"] ? "fixture-only" : "application",
      overridePath,
      sha,
      sourceCheckoutDirty: Boolean(
        (
          await execute(
            "git",
            [
              "status",
              "--porcelain",
              "--untracked-files=all",
              "--",
              ".",
              ":(exclude)artifacts/**",
            ],
            { cwd: root }
          )
        ).stdout.trim()
      ),
      webUrl: values["fixture-only"] ? null : env.CEREBRO_PUBLIC_WEB_URL,
    };
    await writeFile(
      path.join(directory, "boot.json"),
      `${JSON.stringify(report, null, 2)}\n`
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}
