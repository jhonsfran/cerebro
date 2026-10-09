/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- The execution fence and snapshot must complete in order. */
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

import { prepareCutover, restoreRetirementFence } from "./cutover-core.mjs";
import { loadRecord, saveRecord, writeAtomic } from "./durable-record.mjs";
import { schema, retirementSql, legacyMetadata } from "./retirement-sql.mjs";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    directory: { type: "string" },
    file: { multiple: true, type: "string" },
    project: { type: "string" },
    "restore-fence": { type: "boolean" },
  },
});
if (!/^[a-z0-9][a-z0-9_-]*$/u.test(values.project ?? "") || !values.directory) {
  throw new Error(
    "Use --project NAME --directory PATH [--file COMPOSE_FILE] [--restore-fence]."
  );
}
const directory = path.resolve(values.directory);
const files = values.file ?? [path.join(root, "compose.yaml")];
const docker = async (args) =>
  (
    await execute("docker", args, {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
    })
  ).stdout.trim();
const inspect = async () => {
  const ids = await docker([
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${values.project}`,
  ]);
  if (!ids) {
    throw new Error("The selected project does not exist.");
  }
  return JSON.parse(await docker(["inspect", ...ids.split("\n")]));
};
const stores = new Set(["postgres", "minio-runtime", "minio-artifacts"]);
const clients = (containers) =>
  containers.filter(
    (item) => !stores.has(item.Config.Labels["com.docker.compose.service"])
  );
const assertStopped = async () => {
  const oldClients = clients(await inspect());
  if (
    oldClients.some(
      (item) =>
        item.State.Running ||
        !["", "no"].includes(item.HostConfig.RestartPolicy.Name)
    )
  ) {
    throw new Error(
      "Execution, admission and delivery must remain stopped with automatic restart disabled."
    );
  }
};
const sql = async (statement) => {
  const containers = await inspect();
  const postgres = containers.find(
    (item) => item.Config.Labels["com.docker.compose.service"] === "postgres"
  );
  if (!postgres?.State.Running) {
    throw new Error(
      "Start only the selected project's PostgreSQL store before applying its fence."
    );
  }
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
    {
      encoding: "utf-8",
      input: statement,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    }
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      "The retirement transaction failed. Execution remains stopped."
    );
  }
  return result.stdout.trim();
};
const recordPath = path.join(directory, "retirement.json");
const readRecord = async () => {
  const record = await loadRecord(recordPath);
  if (
    record.engine !== "pi-v1" ||
    record.phase !== "retired" ||
    typeof record.project !== "string"
  ) {
    throw new Error("Invalid completed retirement record.");
  }
  return record;
};
const completeManifest = async (record) => {
  const payload = `${JSON.stringify({ ...record, project: values.project }, null, 2)}\n`;
  const manifestPath = path.join(directory, "stores", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  if (
    manifest.sourceProject !== values.project ||
    manifest.engineRetirement?.engine !== "pi-v1"
  ) {
    throw new Error("The retained backup is not bound to this retirement.");
  }
  manifest.engineRetirement = JSON.parse(payload);
  await writeAtomic(manifestPath, manifest);
};
const operations = {
  assertExecutionStopped: assertStopped,
  commitFence: async () =>
    JSON.parse(
      await sql(
        `${schema} INSERT INTO cerebro_engine_retirement(singleton, phase, engine) VALUES(TRUE,'fenced','pi-v1') ON CONFLICT(singleton) DO NOTHING; ${legacyMetadata} SELECT row_to_json(r) FROM cerebro_engine_retirement r WHERE singleton;`
      )
    ),
  readFence: async () => {
    try {
      const record = await readRecord();
      if (record.project !== values.project) {
        throw new Error("The retirement record belongs to another project.");
      }
      return record;
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  },
  retireAndQuarantine: async () => JSON.parse(await sql(retirementSql)),
  saveRetirement: async (record) => {
    await completeManifest(record);
    await saveRecord(recordPath, { ...record, project: values.project });
  },
  saveSnapshot: async (unresolved, fence) => {
    await mkdir(directory, { mode: 0o700, recursive: true });
    const filename = path.join(directory, "unresolved.json");
    try {
      const saved = JSON.parse(await readFile(filename, "utf-8"));
      if (saved.project !== values.project || saved.fence.engine !== "pi-v1") {
        throw new Error(
          "The unresolved snapshot belongs to another retirement."
        );
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await writeAtomic(filename, {
        fence,
        project: values.project,
        unresolved,
      });
    }
  },
  snapshotStores: async () => {
    const storesPath = path.join(directory, "stores");
    try {
      await readFile(path.join(storesPath, "manifest.json"), "utf-8");
      await execute(
        "node",
        [
          "deploy/backup.mjs",
          "verify",
          "--project",
          values.project,
          "--directory",
          storesPath,
        ],
        { cwd: root, timeout: 60_000 }
      );
      return;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      try {
        await rename(storesPath, `${storesPath}.incomplete-${randomUUID()}`);
      } catch (renameError) {
        if (renameError.code !== "ENOENT") {
          throw renameError;
        }
      }
    }
    await execute(
      "node",
      [
        "deploy/backup.mjs",
        "backup",
        "--project",
        values.project,
        "--directory",
        storesPath,
        "--retirement-fence",
        path.join(directory, "unresolved.json"),
        ...files.flatMap((file) => ["--file", path.resolve(file)]),
      ],
      { cwd: root, maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60_000 }
    );
  },
  snapshotUnresolved: async () =>
    JSON.parse(
      await sql(`SELECT json_build_object(
    'conversations', (SELECT coalesce(json_agg(c), '[]') FROM channel_conversation c WHERE engine='legacy-v1'),
    'replies', (SELECT coalesce(json_agg(r), '[]') FROM channel_reply r JOIN channel_conversation c USING(conversation_id) WHERE c.engine='legacy-v1' AND r.state IN ('ready','sending')));`)
    ),
  stopExecution: async () => {
    const containers = await inspect();
    const volumeIds = new Set(
      containers.flatMap((item) =>
        item.Mounts.filter((mount) => mount.Type === "volume").map(
          (mount) => mount.Name
        )
      )
    );
    for (const volume of volumeIds) {
      const users = await docker(["ps", "-aq", "--filter", `volume=${volume}`]);
      if (
        users
          .split("\n")
          .filter(Boolean)
          .some((id) => !containers.some((item) => item.Id.startsWith(id)))
      ) {
        throw new Error("A project store is shared with another container.");
      }
    }
    const oldClients = clients(containers);
    if (oldClients.length) {
      await docker([
        "update",
        "--restart=no",
        ...oldClients.map((item) => item.Id),
      ]);
    }
    const ids = oldClients
      .filter((item) => item.State.Running)
      .map((item) => item.Id);
    if (ids.length) {
      await docker(["stop", "--time", "30", ...ids]);
    }
  },
  verifyRetirement: async () => {
    const current = JSON.parse(
      await sql(
        `${schema} SELECT row_to_json(r) FROM cerebro_engine_retirement r WHERE singleton;`
      )
    );
    if (current.phase !== "retired" || current.engine !== "pi-v1") {
      throw new Error(
        "The selected stores do not contain the completed retirement fence."
      );
    }
    await assertStopped();
    await completeManifest(current);
  },
};
await (values["restore-fence"]
  ? restoreRetirementFence(operations, await readRecord())
  : prepareCutover(operations));
process.stdout.write(
  "Retirement fence retained. Execution remains stopped. Start only a reviewed Pi release after the fence is verified.\n"
);
