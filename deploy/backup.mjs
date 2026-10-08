/* eslint-disable no-await-in-loop -- Docker mutations must complete in order. */
import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { writeAtomic } from "./durable-record.mjs";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const helperImage =
  "node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8";
const logicalNames = [
  "postgres",
  "minio-runtime",
  "minio-artifacts",
  "celld",
  "secrets",
  "postgres-credential",
  "minio-credential",
];
const storageServices = new Set([
  "postgres",
  "minio-runtime",
  "minio-artifacts",
]);
const projectPattern = /^[a-z0-9][a-z0-9_-]*$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
let interrupted = false;

const run = async (command, args, recovery = false) => {
  if (interrupted && !recovery) {
    throw new Error("Backup interrupted");
  }
  try {
    const result = await execute(command, args, {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
    if (interrupted && !recovery) {
      throw new Error("Backup interrupted");
    }
    return result.stdout.trim();
  } catch {
    throw new Error(
      `${command} operation failed. Command output is withheld to protect credentials.`
    );
  }
};

const hashFile = async (filename) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const optionsFrom = (args) => {
  const [operation, ...flags] = args;
  if (!["backup", "restore", "verify"].includes(operation)) {
    throw new Error(
      "Use backup, restore or verify with --project NAME --directory PATH [--file COMPOSE_FILE]."
    );
  }
  const options = { files: [], operation };
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (flag === "--file") {
      options.files.push(path.resolve(value));
    } else if (
      flag === "--project" ||
      flag === "--directory" ||
      flag === "--retirement-fence"
    ) {
      const key = flag.slice(2);
      if (options[key]) {
        throw new Error(`Duplicate ${flag}`);
      }
      options[key] = value;
    } else {
      throw new Error(`Unknown option ${flag}`);
    }
  }
  if (
    !options.project ||
    !projectPattern.test(options.project) ||
    !options.directory
  ) {
    throw new Error("A valid --project and --directory are required.");
  }
  options.directory = path.resolve(options.directory);
  if (options.directory.includes(",")) {
    throw new Error("The archive directory cannot contain a comma.");
  }
  if (options.files.length === 0) {
    options.files.push(path.join(root, "compose.yaml"));
  }
  return options;
};

const composeArguments = (options) => [
  "compose",
  "--project-directory",
  root,
  "-p",
  options.project,
  ...options.files.flatMap((file) => ["-f", file]),
];

const configuration = async (options) => {
  const config = JSON.parse(
    await run("docker", [
      ...composeArguments(options),
      "config",
      "--format",
      "json",
    ])
  );
  const names = Object.keys(config.volumes ?? {});
  if (
    names.length !== logicalNames.length ||
    logicalNames.some((name) => !names.includes(name))
  ) {
    throw new Error("Compose must declare exactly the seven Cerebro volumes.");
  }
  for (const volume of Object.values(config.volumes)) {
    if (
      volume.external ||
      (volume.driver && volume.driver !== "local") ||
      Object.keys(volume.driver_opts ?? {}).length > 0 ||
      !volume.name ||
      !projectPattern.test(volume.name)
    ) {
      throw new Error(
        "Only project-owned local Docker volumes without driver options are supported."
      );
    }
    if (!volume.name.startsWith(`${options.project}_`)) {
      throw new Error(
        "Every volume name must use the selected Compose project prefix."
      );
    }
  }
  if (
    new Set(Object.values(config.volumes).map((volume) => volume.name)).size !==
    logicalNames.length
  ) {
    throw new Error("Each logical store must have a distinct Docker volume.");
  }
  for (const service of Object.values(config.services ?? {})) {
    if (
      (service.volumes ?? []).some(
        (volume) =>
          volume.type !== "volume" || !logicalNames.includes(volume.source)
      )
    ) {
      throw new Error(
        "Bind mounts and non-Cerebro volumes are unsupported. Back up production secrets separately before a manual quiescent backup."
      );
    }
  }
  return config;
};

const containersFor = async (project) => {
  const ids = await run("docker", [
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);
  return ids
    ? JSON.parse(await run("docker", ["inspect", ...ids.split("\n")]))
    : [];
};

const volumeNames = async () => {
  const output = await run("docker", ["volume", "ls", "--quiet"]);
  return new Set(output.split("\n"));
};

const assertUnused = async (config) => {
  for (const volume of Object.values(config.volumes)) {
    const users = await run("docker", [
      "ps",
      "--quiet",
      "--filter",
      `volume=${volume.name}`,
    ]);
    if (users) {
      throw new Error("A source volume still has a running container.");
    }
  }
};

const secureFile = async (filename) => {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      "The backup must contain regular files, without symbolic links."
    );
  }
};

const validateManifest = (manifest) => {
  if (
    manifest.schemaVersion !== 1 ||
    !projectPattern.test(manifest.sourceProject ?? "") ||
    !/^[a-f0-9]{40}$/u.test(manifest.release ?? "") ||
    !manifest.images ||
    typeof manifest.images !== "object" ||
    Array.isArray(manifest.images) ||
    !Array.isArray(manifest.volumeArchives)
  ) {
    throw new Error("Invalid BackupManifest");
  }
  if (
    manifest.volumeArchives.length !== logicalNames.length ||
    new Set(manifest.volumeArchives.map((entry) => entry.logicalName)).size !==
      logicalNames.length
  ) {
    throw new Error(
      "BackupManifest must contain each of the seven logical volumes exactly once."
    );
  }
  for (const image of Object.values(manifest.images)) {
    if (
      !image ||
      typeof image !== "object" ||
      !/^sha256:[a-f0-9]{64}$/u.test(image.id ?? "") ||
      (image.reference !== null && typeof image.reference !== "string")
    ) {
      throw new Error("Invalid image identity in BackupManifest");
    }
  }
};

const readManifest = async (directory) => {
  await secureFile(path.join(directory, "manifest.json"));
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf-8")
  );
  validateManifest(manifest);
  for (const entry of manifest.volumeArchives) {
    if (
      !logicalNames.includes(entry.logicalName) ||
      !digestPattern.test(entry.sha256 ?? "")
    ) {
      throw new Error("Invalid volume archive entry");
    }
    const filename = path.join(directory, `${entry.logicalName}.tar`);
    await secureFile(filename);
    if ((await hashFile(filename)) !== entry.sha256) {
      throw new Error(`Archive checksum mismatch for ${entry.logicalName}`);
    }
  }
  if (
    manifest.engineRetirement &&
    (manifest.engineRetirement.engine !== "pi-v1" ||
      manifest.engineRetirement.project !== manifest.sourceProject ||
      !["fenced", "retired"].includes(manifest.engineRetirement.phase))
  ) {
    throw new Error("Invalid retirement fence in BackupManifest");
  }
  return manifest;
};

const archiveArguments = (directory, volumeName, readonly) => [
  "run",
  "--rm",
  "--network",
  "none",
  "--read-only",
  "--mount",
  `type=volume,src=${volumeName},dst=/volume${readonly ? ",readonly" : ""}`,
  "--mount",
  `type=bind,src=${directory},dst=/backup${readonly ? "" : ",readonly"}`,
  "--entrypoint",
  "tar",
  helperImage,
];

const backupRetirement = async (options) => {
  const engineRetirement = options["retirement-fence"]
    ? {
        ...JSON.parse(
          await readFile(path.resolve(options["retirement-fence"]), "utf-8")
        ).fence,
        project: options.project,
      }
    : undefined;
  if (
    engineRetirement &&
    (engineRetirement.engine !== "pi-v1" || engineRetirement.phase !== "fenced")
  ) {
    throw new Error("Backup requires the committed execution fence.");
  }
  return engineRetirement;
};

const backup = async (options, config) => {
  const containers = await containersFor(options.project);
  if (containers.length === 0) {
    throw new Error("The source Compose project has no containers.");
  }
  const expectedVolumes = new Set(
    Object.values(config.volumes).map((volume) => volume.name)
  );
  for (const container of containers) {
    if (
      container.Config.Labels["com.docker.compose.oneoff"] === "True" ||
      container.Mounts.some(
        (mount) => mount.Type !== "volume" || !expectedVolumes.has(mount.Name)
      )
    ) {
      throw new Error(
        "Source containers have unsupported mounts or one-off services. Use the deployed Compose configuration."
      );
    }
  }
  const existing = await volumeNames();
  for (const volume of Object.values(config.volumes)) {
    if (!existing.has(volume.name)) {
      throw new Error("The source is missing a required volume.");
    }
    const users = await run("docker", [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `volume=${volume.name}`,
    ]);
    if (
      users
        .split("\n")
        .filter(Boolean)
        .some(
          (id) => !containers.some((container) => container.Id.startsWith(id))
        )
    ) {
      throw new Error("A source volume is shared with another container.");
    }
  }
  const running = [
    ...new Set(
      containers
        .filter((container) => container.State.Running)
        .map(
          (container) => container.Config.Labels["com.docker.compose.service"]
        )
    ),
  ];
  const release = await run("git", ["rev-parse", "HEAD"]);
  const sourceCheckoutDirty = Boolean(
    await run("git", [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude)artifacts/**",
    ])
  );
  const images = {};
  for (const container of containers) {
    const service = container.Config.Labels["com.docker.compose.service"];
    images[service] = {
      id: container.Image,
      reference: config.services[service]?.image ?? null,
    };
  }
  if (Object.keys(config.services).some((service) => !images[service])) {
    throw new Error(
      "Each configured service must have a source container to record its image identity."
    );
  }
  await run("docker", ["image", "inspect", helperImage]);
  await mkdir(options.directory, { mode: 0o700 });
  await chmod(options.directory, 0o700);
  const volumeArchives = [];
  const compose = composeArguments(options);
  let failure;
  try {
    const clients = running.filter((service) => !storageServices.has(service));
    const storage = running.filter((service) => storageServices.has(service));
    if (clients.length > 0) {
      await run("docker", [...compose, "stop", "--timeout", "60", ...clients]);
    }
    if (storage.length > 0) {
      await run("docker", [...compose, "stop", "--timeout", "60", ...storage]);
    }
    await assertUnused(config);
    for (const logicalName of logicalNames) {
      await writeFile(path.join(options.directory, `${logicalName}.tar`), "", {
        flag: "wx",
        mode: 0o600,
      });
      await run("docker", [
        ...archiveArguments(
          options.directory,
          config.volumes[logicalName].name,
          true
        ),
        "--create",
        `--file=/backup/${logicalName}.tar`,
        "--directory=/volume",
        ".",
      ]);
      const filename = path.join(options.directory, `${logicalName}.tar`);
      await chmod(filename, 0o600);
      volumeArchives.push({ logicalName, sha256: await hashFile(filename) });
    }
  } catch (error) {
    failure = error;
  } finally {
    if (running.length > 0) {
      try {
        await run(
          "docker",
          [...compose, "start", "--wait", "--wait-timeout", "120", ...running],
          true
        );
      } catch {
        failure = new Error(
          "Source services could not all resume. Inspect the source project before retrying."
        );
      }
    }
  }
  if (failure) {
    throw failure;
  }
  const engineRetirement = await backupRetirement(options);
  await writeAtomic(path.join(options.directory, "manifest.json"), {
    engineRetirement,
    images,
    release,
    schemaVersion: 1,
    sourceCheckoutDirty,
    sourceProject: options.project,
    volumeArchives,
  });
  process.stdout.write(`Backup complete in ${options.directory}\n`);
};

const restoreRetirement = async (options, overridePath) => {
  const compose = [...composeArguments(options), "-f", overridePath];
  await run("docker", [
    ...compose,
    "up",
    "-d",
    "--no-deps",
    "--wait",
    "--wait-timeout",
    "120",
    ...storageServices,
  ]);
  const containers = await containersFor(options.project);
  const postgres = containers.find(
    (container) =>
      container.Config.Labels["com.docker.compose.service"] === "postgres"
  );
  const { retirementSql } = await import("./retirement-sql.mjs");
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      postgres.Id,
      "psql",
      "-U",
      "cerebro",
      "-d",
      "cerebro",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { encoding: "utf-8", input: retirementSql, timeout: 30_000 }
  );
  if (result.error || result.status !== 0) {
    throw new Error("Restore retirement failed. Execution remains stopped.");
  }
  const retired = JSON.parse(result.stdout.trim());
  const restored = await containersFor(options.project);
  if (
    retired.phase !== "retired" ||
    retired.engine !== "pi-v1" ||
    restored.some(
      (container) =>
        container.State.Running &&
        !storageServices.has(
          container.Config.Labels["com.docker.compose.service"]
        )
    )
  ) {
    throw new Error("The restored execution fence is invalid.");
  }
  await writeFile(
    path.join(options.directory, `${options.project}.retirement.json`),
    `${JSON.stringify(retired, null, 2)}\n`,
    { flag: "wx", mode: 0o600 }
  );
  process.stdout.write(
    `Retirement reapplied in ${options.project}. Only stores are running. Enable only a reviewed Pi release.\n`
  );
};

const restore = async (options, config, manifest) => {
  if (
    manifest.engineRetirement &&
    manifest.engineRetirement.phase !== "retired"
  ) {
    throw new Error(
      "Complete the source retirement before restoring its retained stores."
    );
  }
  if (options.project === manifest.sourceProject) {
    throw new Error("The restore project must differ from the source project.");
  }
  if (manifest.release !== (await run("git", ["rev-parse", "HEAD"]))) {
    throw new Error(
      "Restore requires the source Git release. Check out the manifest release first."
    );
  }
  if (manifest.images.postgres?.reference !== config.services.postgres?.image) {
    throw new Error(
      "Cold PostgreSQL restore requires the exact source PostgreSQL image reference."
    );
  }
  const targetContainers = await containersFor(options.project);
  if (targetContainers.length > 0) {
    throw new Error("The restore project already has containers.");
  }
  const existing = await volumeNames();
  const owned = await run("docker", [
    "volume",
    "ls",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${options.project}`,
  ]);
  if (
    owned ||
    [...existing].some((name) => name.startsWith(`${options.project}_`)) ||
    Object.values(config.volumes).some((volume) => existing.has(volume.name))
  ) {
    throw new Error(
      "The restore project already has volumes. Use a fresh project."
    );
  }
  const serviceNames = Object.keys(config.services);
  if (
    serviceNames.length !== Object.keys(manifest.images).length ||
    serviceNames.some(
      (service) => !projectPattern.test(service) || !manifest.images[service]
    )
  ) {
    throw new Error(
      "Restore requires the same Compose service set as the backup."
    );
  }
  await run("docker", [
    "image",
    "inspect",
    ...new Set(Object.values(manifest.images).map((image) => image.id)),
    helperImage,
  ]);
  const overridePath = path.join(
    options.directory,
    `${options.project}.images.yaml`
  );
  try {
    await lstat(overridePath);
    throw new Error(
      "The restore image override already exists. Use a fresh project."
    );
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  for (const entry of manifest.volumeArchives) {
    await run("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--mount",
      `type=bind,src=${options.directory},dst=/backup,readonly`,
      "--entrypoint",
      "tar",
      helperImage,
      "--list",
      `--file=/backup/${entry.logicalName}.tar`,
    ]);
  }
  const token = randomUUID();
  for (const logicalName of logicalNames) {
    const { name } = config.volumes[logicalName];
    await run("docker", [
      "volume",
      "create",
      "--label",
      `com.docker.compose.project=${options.project}`,
      "--label",
      `com.docker.compose.volume=${logicalName}`,
      "--label",
      `cerebro.restore=${token}`,
      name,
    ]);
    const [volume] = JSON.parse(
      await run("docker", ["volume", "inspect", name])
    );
    if (volume.Labels["cerebro.restore"] !== token) {
      throw new Error(
        "A target volume appeared during restore. No existing volume will be overwritten."
      );
    }
    await run("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--mount",
      `type=volume,src=${name},dst=/volume`,
      "--entrypoint",
      "node",
      helperImage,
      "-e",
      "if(require('node:fs').readdirSync('/volume').length)process.exit(1)",
    ]);
    await run("docker", [
      ...archiveArguments(options.directory, name, false),
      "--extract",
      `--file=/backup/${logicalName}.tar`,
      "--directory=/volume",
      "--same-owner",
      "--same-permissions",
    ]);
  }
  const override = [
    "services:",
    ...serviceNames.flatMap((service) => [
      `  ${service}:`,
      "    build: !reset null",
      `    image: ${manifest.images[service].id}`,
      "    pull_policy: never",
    ]),
  ].join("\n");
  await writeFile(overridePath, `${override}\n`, { flag: "wx", mode: 0o600 });
  if (manifest.engineRetirement) {
    await restoreRetirement(options, overridePath);
    return;
  }
  process.stdout.write(
    `Restore complete in Compose project ${options.project}. Start with the image override ${overridePath} and do not rebuild.\n`
  );
};

try {
  const options = optionsFrom(process.argv.slice(2));
  process.on("SIGINT", () => {
    interrupted = true;
  });
  process.on("SIGTERM", () => {
    interrupted = true;
  });
  const manifest =
    options.operation === "restore" || options.operation === "verify"
      ? await readManifest(options.directory)
      : undefined;
  if (options.operation === "verify") {
    if (manifest.sourceProject !== options.project) {
      throw new Error("The archive belongs to another project.");
    }
    process.stdout.write("Retained store checksums verified.\n");
  } else {
    if (manifest?.sourceProject === options.project) {
      throw new Error(
        "The restore project must differ from the source project."
      );
    }
    const config = await configuration(options);
    await (options.operation === "backup"
      ? backup(options, config)
      : restore(options, config, manifest));
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
