/* eslint-disable no-await-in-loop -- Fixture mutations and archive reads run in order. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const helperImage =
  "node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8";
const state = {
  celld: "cell=conversation-17;wal=42",
  "minio-artifacts": "artifact=report-17;memory=source-17;grant=alice",
  "minio-credential": "minio-password=original-store-key",
  "minio-runtime": "session=conversation-17;event-sequence=42",
  postgres: "auth-user=alice;ledger=paid;projection=conversation-17",
  "postgres-credential": "postgres-password=original-db-key",
  secrets: "auth-secret=original-auth-key",
};
const names = Object.keys(state);
const script = path.resolve("deploy/backup.mjs");
const docker = (...args: string[]) =>
  exec("docker", args, { maxBuffer: 4 * 1024 * 1024, timeout: 180_000 });
const backupCli = (...args: string[]) =>
  exec(process.execPath, [script, ...args], {
    maxBuffer: 4 * 1024 * 1024,
    timeout: 180_000,
  });

const makeManifest = async (directory: string): Promise<void> => {
  const archives = [];
  for (const logicalName of names) {
    const bytes = Buffer.from(`bytes-${logicalName}`);
    await writeFile(path.join(directory, `${logicalName}.tar`), bytes, {
      mode: 0o600,
    });
    archives.push({
      logicalName,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      images: {},
      release: "a".repeat(40),
      schemaVersion: 1,
      sourceProject: "original",
      volumeArchives: archives,
    }),
    { mode: 0o600 }
  );
};

const errorText = (error: unknown): string => {
  if (error && typeof error === "object" && "stderr" in error) {
    return String(error.stderr);
  }
  return String(error);
};

const expectFailure = async (
  args: string[],
  expected: RegExp
): Promise<void> => {
  await assert.rejects(backupCli(...args), (error: unknown) => {
    assert.match(errorText(error), expected);
    return true;
  });
};

test("the restore CLI rejects a corrupt archive before Docker access", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cerebro-backup-corrupt-")
  );
  await makeManifest(directory);
  await writeFile(path.join(directory, "secrets.tar"), "changed-secret");
  await expectFailure(
    ["restore", "--project", "fresh", "--directory", directory],
    /Archive checksum mismatch for secrets/u
  );
});

test("the restore CLI rejects the source project before Docker access", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cerebro-backup-same-")
  );
  await makeManifest(directory);
  await expectFailure(
    ["restore", "--project", "original", "--directory", directory],
    /must differ from the source project/u
  );
});

test("the CLI rejects invalid projects and duplicate arguments", async () => {
  await expectFailure(
    ["backup", "--project", "../unsafe", "--directory", "/tmp/unused"],
    /valid --project/u
  );
  await expectFailure(
    [
      "backup",
      "--project",
      "safe",
      "--project",
      "other",
      "--directory",
      "/tmp/unused",
    ],
    /Duplicate --project/u
  );
});

test(
  "Docker backup restores all seven stores and resumes only original services",
  { timeout: 240_000 },
  async (context) => {
    try {
      await docker("info", "--format", "{{.ServerVersion}}");
    } catch {
      context.skip(
        "Docker is unavailable. The real snapshot and restore check did not run."
      );
      return;
    }
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "cerebro-backup-docker-")
    );
    const source = `cerebro-backup-${randomBytes(5).toString("hex")}`;
    const target = `${source}-restored`;
    const occupied = `${source}-occupied`;
    const volumeTarget = `${source}-volume`;
    const composeFile = path.join(directory, "compose.json");
    const archiveDirectory = path.join(directory, "snapshot");
    const services = {
      api: {
        command: [
          "node",
          "-e",
          'setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0))',
        ],
        image: helperImage,
        volumes: ["secrets:/secrets:ro"],
      },
      celld: {
        command: [
          "node",
          "-e",
          'setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0))',
        ],
        image: helperImage,
        volumes: ["celld:/state"],
      },
      "credential-state": {
        command: [
          "node",
          "-e",
          'setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0))',
        ],
        image: helperImage,
        volumes: [
          "secrets:/secrets",
          "postgres-credential:/postgres",
          "minio-credential:/minio",
        ],
      },
      "minio-artifacts": {
        command: [
          "node",
          "-e",
          'setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0))',
        ],
        image: helperImage,
        volumes: ["minio-artifacts:/state"],
      },
      "minio-runtime": {
        command: [
          "node",
          "-e",
          'setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0))',
        ],
        image: helperImage,
        volumes: ["minio-runtime:/state"],
      },
      postgres: {
        command: [
          "node",
          "-e",
          'setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0))',
        ],
        image: helperImage,
        volumes: ["postgres:/state"],
      },
      web: {
        command: [
          "node",
          "-e",
          'setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0))',
        ],
        image: helperImage,
      },
    };
    const volumes = Object.fromEntries(names.map((name) => [name, {}]));
    await writeFile(composeFile, JSON.stringify({ services, volumes }));
    const compose = (project: string, ...args: string[]) =>
      docker("compose", "-p", project, "-f", composeFile, ...args);
    const cliArguments = (operation: string, project: string) => [
      operation,
      "--project",
      project,
      "--directory",
      archiveDirectory,
      "--file",
      composeFile,
    ];
    const runningServices = async (project: string): Promise<string[]> => {
      const result = await compose(
        project,
        "ps",
        "--services",
        "--status",
        "running"
      );
      return result.stdout.trim().split("\n").filter(Boolean).toSorted();
    };
    let passed = false;
    try {
      await docker("pull", helperImage);
      await compose(source, "up", "-d");
      await compose(source, "stop", "minio-artifacts", "credential-state");
      for (const [name, contents] of Object.entries(state)) {
        await docker(
          "run",
          "--rm",
          "--network",
          "none",
          "--mount",
          `type=volume,src=${source}_${name},dst=/state`,
          helperImage,
          "node",
          "-e",
          "const fs=require('node:fs');fs.writeFileSync('/state/record',process.argv[1],{mode:0o600});fs.symlinkSync('record','/state/current')",
          contents
        );
      }
      const before = await runningServices(source);
      assert.deepEqual(before, [
        "api",
        "celld",
        "minio-runtime",
        "postgres",
        "web",
      ]);
      const snapshot = await backupCli(...cliArguments("backup", source));
      assert.match(snapshot.stdout, /Backup complete/u);
      assert.deepEqual(await runningServices(source), before);
      const interruptedDirectory = path.join(directory, "interrupted");
      const interruptedBackup = backupCli(
        "backup",
        "--project",
        source,
        "--directory",
        interruptedDirectory,
        "--file",
        composeFile
      );
      const interruptedFailure = assert.rejects(
        interruptedBackup,
        /operation failed|interrupted/u
      );
      let stoppedClient = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const client = await docker(
          "ps",
          "--quiet",
          "--filter",
          `label=com.docker.compose.project=${source}`,
          "--filter",
          "label=com.docker.compose.service=api"
        );
        if (!client.stdout.trim()) {
          stoppedClient = true;
          interruptedBackup.child.kill("SIGTERM");
          break;
        }
        await setTimeout(50);
      }
      assert.equal(
        stoppedClient,
        true,
        "the interruption must happen after the source client stops"
      );
      await interruptedFailure;
      assert.deepEqual(await runningServices(source), before);
      await assert.rejects(
        readFile(path.join(interruptedDirectory, "manifest.json")),
        { code: "ENOENT" }
      );
      const directoryStat = await stat(archiveDirectory);
      assert.equal(directoryStat.mode % 0o1000, 0o700);
      for (const name of names) {
        const archiveStat = await stat(
          path.join(archiveDirectory, `${name}.tar`)
        );
        assert.equal(archiveStat.mode % 0o1000, 0o600);
      }
      const manifest = JSON.parse(
        await readFile(path.join(archiveDirectory, "manifest.json"), "utf-8")
      );
      assert.equal(manifest.sourceProject, source);
      assert.equal(manifest.schemaVersion, 1);
      assert.equal(manifest.images.postgres.reference, helperImage);

      await expectFailure(
        cliArguments("restore", source),
        /must differ from the source project/u
      );
      const boundFile = path.join(directory, "bind-compose.json");
      await writeFile(
        boundFile,
        JSON.stringify({
          services: {
            ...services,
            api: { ...services.api, volumes: [`${directory}:/secrets:ro`] },
          },
          volumes,
        })
      );
      await expectFailure(
        [
          "backup",
          "--project",
          source,
          "--directory",
          path.join(directory, "refused"),
          "--file",
          boundFile,
        ],
        /Bind mounts/u
      );
      assert.deepEqual(await runningServices(source), before);

      await compose(occupied, "up", "-d", "web");
      await expectFailure(
        cliArguments("restore", occupied),
        /already has containers/u
      );
      await docker("volume", "create", `${volumeTarget}_orphan`);
      await expectFailure(
        cliArguments("restore", volumeTarget),
        /already has volumes/u
      );
      const inspected = await docker(
        "volume",
        "inspect",
        `${volumeTarget}_orphan`
      );
      const unchanged = inspected.stdout;
      assert.match(unchanged, /_orphan/u);
      await backupCli(...cliArguments("restore", target));
      assert.deepEqual(await runningServices(target), []);
      for (const [name, contents] of Object.entries(state)) {
        const restored = await docker(
          "run",
          "--rm",
          "--network",
          "none",
          "--mount",
          `type=volume,src=${target}_${name},dst=/state,readonly`,
          helperImage,
          "node",
          "-e",
          "const fs=require('node:fs');process.stdout.write(JSON.stringify({record:fs.readFileSync('/state/record','utf8'),link:fs.readlinkSync('/state/current'),mode:fs.statSync('/state/record').mode&511}))"
        );
        assert.deepEqual(JSON.parse(restored.stdout), {
          link: "record",
          mode: 0o600,
          record: contents,
        });
      }
      const overrideFile = path.join(archiveDirectory, `${target}.images.yaml`);
      const pinned = await docker(
        "compose",
        "-p",
        target,
        "-f",
        composeFile,
        "-f",
        overrideFile,
        "config",
        "--format",
        "json"
      );
      const pinnedServices = JSON.parse(pinned.stdout).services;
      for (const service of Object.keys(services)) {
        assert.equal(
          pinnedServices[service].image,
          manifest.images[service].id
        );
        assert.equal(pinnedServices[service].pull_policy, "never");
        assert.equal(pinnedServices[service].build, undefined);
      }
      await docker(
        "compose",
        "-p",
        target,
        "-f",
        composeFile,
        "-f",
        overrideFile,
        "up",
        "-d"
      );
      assert.deepEqual(await runningServices(target), [
        "api",
        "celld",
        "credential-state",
        "minio-artifacts",
        "minio-runtime",
        "postgres",
        "web",
      ]);
      await expectFailure(
        cliArguments("restore", target),
        /already has containers/u
      );
      assert.deepEqual(await runningServices(source), before);
      passed = true;
    } finally {
      if (passed) {
        for (const project of [source, target, occupied, volumeTarget]) {
          await compose(project, "down", "--volumes");
        }
        await docker("volume", "rm", `${volumeTarget}_orphan`);
      } else {
        process.stderr.write(
          `Backup fixtures retained for diagnosis in ${directory}, projects ${source}, ${target}, ${occupied}, ${volumeTarget}\n`
        );
      }
    }
  }
);
