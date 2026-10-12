/* oxlint-disable no-await-in-loop -- Cold restore and store fingerprints require ordered physical operations. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { z } from "zod";

import type { ApplicationBoot } from "../slice-1/application.ts";
import {
  applicationFixture,
  freeFixturePort,
  stackFiles,
} from "../slice-1/application.ts";

const executeFile = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const dataTables = [
  "cerebro_audit_event",
  "connector_account",
  "connector_tool",
  "memory_source",
  "memory_record",
  "memory_artifact",
] as const;
const stores = [
  "postgres",
  "minio-runtime",
  "minio-artifacts",
  "celld",
  "secrets",
  "postgres-credential",
  "minio-credential",
] as const;
const manifestSchema = z.object({
  images: z.record(z.string(), z.object({ id: z.string() })),
  release: z.string(),
  sourceCheckoutDirty: z.boolean(),
  sourceProject: z.string(),
  volumeArchives: z.array(
    z.object({ logicalName: z.string(), sha256: z.string() })
  ),
});
const fingerprints = async (fixture: ReturnType<typeof applicationFixture>) => {
  const rows: Record<string, string> = {};
  for (const table of dataTables) {
    rows[table] = await fixture.sql(
      `SELECT count(*) || ':' || md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) FROM ${table} t`
    );
  }
  return rows;
};
const provider = async (fixtureUrl: string) => {
  const response = await fetch(`${fixtureUrl}/observations`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  return z
    .object({ model: z.array(z.unknown()), tools: z.array(z.unknown()) })
    .parse(await response.json());
};
interface RestoreInput {
  readonly boot: ApplicationBoot;
  readonly cookie: string;
  readonly conversationId: string;
  readonly sourceId: string;
  readonly sourceText: string;
  readonly event: {
    readonly eventId: string;
    readonly text: string;
    readonly mode: "follow-up";
  };
  readonly artifact: {
    readonly artifactId: string;
    readonly organizationId: string;
    readonly provenance: {
      readonly observedAt: number;
      readonly sourceId: string;
      readonly sourceUri: string;
      readonly sourceVersion: string;
    };
    readonly visibility: { readonly kind: "grant"; readonly grantId: string };
  };
}
export const verifyPilotRestore = async (input: RestoreInput) => {
  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "cerebro-pilot-snapshot-")
  );
  await chmod(tempDirectory, 0o700);
  const directory = path.join(tempDirectory, "snapshot");
  const target = `cerebro-s1-pilot-restored-${randomUUID().slice(0, 8)}`;
  const ports = new Set<number>();
  while (ports.size < 3) {
    ports.add(await freeFixturePort());
  }
  const [apiPort, webPort, fixturePort] = [...ports];
  const restoredApi = `http://localhost:${apiPort}`;
  // The immutable web image and restored auth configuration retain the original public origins.
  const sourceEnvironment = {
    ...process.env,
    CEREBRO_API_PORT: new URL(input.boot.apiUrl).port,
    CEREBRO_DATABASE_URL: "",
    CEREBRO_DEPLOY_MODE: "local",
    CEREBRO_FIXTURE_ID: input.boot.fixtureId,
    CEREBRO_FIXTURE_PORT: new URL(input.boot.fixtureUrl).port,
    CEREBRO_FIXTURE_SHA: input.boot.sha,
    CEREBRO_PUBLIC_API_URL: input.boot.apiUrl,
    CEREBRO_PUBLIC_WEB_URL: input.boot.webUrl,
    CEREBRO_WEB_PORT: new URL(input.boot.webUrl).port,
  };
  const restoredEnvironment = {
    ...sourceEnvironment,
    CEREBRO_API_PORT: String(apiPort),
    CEREBRO_FIXTURE_PORT: String(fixturePort),
    CEREBRO_WEB_PORT: String(webPort),
  };
  const files = [...stackFiles, input.boot.overridePath];
  const imageOverride = path.join(directory, `${target}.images.yaml`);
  const execute = (
    command: string,
    args: readonly string[],
    restored = false
  ) =>
    executeFile("rtk", ["proxy", command, ...args], {
      cwd: root,
      encoding: "utf-8",
      env: restored ? restoredEnvironment : sourceEnvironment,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 10 * 60_000,
    });
  const compose = (...args: string[]) =>
    execute(
      "docker",
      [
        "compose",
        "--project-directory",
        root,
        "-p",
        target,
        ...[...files, imageOverride].flatMap((file) => ["-f", file]),
        ...args,
      ],
      true
    );
  const source = applicationFixture(input.boot);
  const restored = applicationFixture({
    ...input.boot,
    apiUrl: restoredApi,
    fixtureId: target,
    fixtureUrl: `http://localhost:${fixturePort}`,
    webUrl: input.boot.webUrl,
  });
  const request = async (
    apiUrl: string,
    route: string,
    body?: unknown
  ): Promise<unknown> => {
    const response = await fetch(`${apiUrl}${route}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Cookie: input.cookie,
        Origin: input.boot.webUrl,
      },
      method: body === undefined ? "GET" : "POST",
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(
      response.status,
      200,
      `Restored ${route}: HTTP ${response.status}`
    );
    return response.json();
  };
  const conversationPath = `/api/product/conversations/${encodeURIComponent(input.conversationId)}`;
  await request(input.boot.apiUrl, conversationPath);
  // Sessions deliver audit records shortly after their runs finish, so the
  // snapshot waits until the source stores stop changing.
  let settled = JSON.stringify(await fingerprints(source));
  let unchanged = 0;
  const settleDeadline = Date.now() + 60_000;
  while (unchanged < 3 && Date.now() < settleDeadline) {
    await delay(1200);
    const next = JSON.stringify(await fingerprints(source));
    unchanged = next === settled ? unchanged + 1 : 0;
    settled = next;
  }
  const previous = await request(input.boot.apiUrl, conversationPath);
  const previousHistory = await request(
    input.boot.apiUrl,
    `${conversationPath}/history`
  );
  const previousAuth = await request(
    input.boot.apiUrl,
    "/api/auth/get-session"
  );
  const previousArtifact = await request(
    input.boot.apiUrl,
    "/rpc/memory/readArtifact",
    {
      json: {
        organizationId: input.artifact.organizationId,
        ref: input.artifact,
      },
    }
  );
  const before = await fingerprints(source);
  for (let sample = 0; sample < 3; sample += 1) {
    await delay(1200);
    assert.deepEqual(
      await fingerprints(source),
      before,
      "Source stores must settle before the cold snapshot"
    );
  }
  const providerBefore = await provider(input.boot.fixtureUrl);
  let passed = false;
  const started = performance.now();
  try {
    // This command stops clients, then storage, and snapshots all seven Docker volumes.
    await execute(process.execPath, [
      "deploy/backup.mjs",
      "backup",
      "--project",
      input.boot.fixtureId,
      "--directory",
      directory,
      ...files.flatMap((file) => ["--file", file]),
    ]);
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf-8"))
    );
    assert.equal(manifest.release, input.boot.sha);
    assert.equal(manifest.sourceProject, input.boot.fixtureId);
    assert.equal(manifest.sourceCheckoutDirty, input.boot.sourceCheckoutDirty);
    assert.deepEqual(
      manifest.volumeArchives.map((store) => store.logicalName).toSorted(),
      [...stores].toSorted()
    );
    const directoryMetadata = await stat(directory);
    assert.equal(directoryMetadata.mode % 0o1000, 0o700);
    for (const name of stores) {
      const archiveMetadata = await stat(path.join(directory, `${name}.tar`));
      assert.equal(archiveMetadata.mode % 0o1000, 0o600);
    }
    await execute(
      process.execPath,
      [
        "deploy/backup.mjs",
        "restore",
        "--project",
        target,
        "--directory",
        directory,
        ...files.flatMap((file) => ["--file", file]),
      ],
      true
    );
    await compose("up", "-d", "--wait", "--wait-timeout", "180", "--no-build");
    const readiness = await fetch(`${restoredApi}/ready`, {
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(readiness.status, 200);
    await readiness.body?.cancel();
    for (const [service, image] of Object.entries(manifest.images)) {
      const container = await restored.container(service);
      const result = await execute(
        "docker",
        ["inspect", "--format", "{{.Image}}", container],
        true
      );
      assert.equal(
        result.stdout.trim(),
        image.id,
        `Restored ${service} must use its immutable source image`
      );
    }
    assert.deepEqual(await fingerprints(restored), before);
    const auth = await request(restoredApi, "/api/auth/get-session");
    z.object({
      session: z.unknown(),
      user: z.object({ id: z.string() }),
    }).parse(auth);
    assert.equal(
      createHash("sha256").update(JSON.stringify(auth)).digest("hex"),
      createHash("sha256").update(JSON.stringify(previousAuth)).digest("hex"),
      "The original cookie must restore the exact private session and user record"
    );
    assert.deepEqual(await request(restoredApi, conversationPath), previous);
    assert.deepEqual(
      await request(restoredApi, `${conversationPath}/history`),
      previousHistory
    );
    const sourceDocument = z
      .object({ text: z.string() })
      .parse(
        await request(
          restoredApi,
          `${conversationPath}/sources/${encodeURIComponent(input.sourceId)}`
        )
      );
    assert.equal(sourceDocument.text, input.sourceText);
    const restoredArtifact = await request(
      restoredApi,
      "/rpc/memory/readArtifact",
      {
        json: {
          organizationId: input.artifact.organizationId,
          ref: input.artifact,
        },
      }
    );
    assert.deepEqual(restoredArtifact, previousArtifact);
    const replay = z
      .object({
        receipt: z.object({
          replayed: z.literal(true),
          runId: z.string(),
          sessionId: z.string(),
        }),
      })
      .parse(
        await request(restoredApi, `${conversationPath}/messages`, input.event)
      );
    const previousSnapshot = z
      .object({
        sessionId: z.string(),
        snapshot: z.object({
          outputs: z.array(
            z.object({ citations: z.array(z.object({ sourceId: z.string() })) })
          ),
          runs: z.array(z.object({ runId: z.string() })),
        }),
      })
      .parse(previous);
    assert.equal(replay.receipt.sessionId, previousSnapshot.sessionId);
    assert.equal(
      replay.receipt.runId,
      previousSnapshot.snapshot.runs[0]?.runId
    );
    assert.ok(
      previousSnapshot.snapshot.outputs.some((output) =>
        output.citations.some(
          (citation) => citation.sourceId === input.sourceId
        )
      )
    );
    for (let sample = 0; sample < 3; sample += 1) {
      await delay(1200);
      assert.deepEqual(await request(restoredApi, conversationPath), previous);
      assert.deepEqual(await fingerprints(restored), before);
      assert.deepEqual(
        await provider(`http://localhost:${fixturePort}`),
        providerBefore,
        "Cold restore, authorization, and exact replay must cause zero model calls or physical effects"
      );
    }
    passed = true;
    return {
      apiOrigin: restoredApi,
      elapsedMs: Math.round(performance.now() - started),
      fingerprints: before,
      originalPublicApiOrigin: input.boot.apiUrl,
      originalPublicWebOrigin: input.boot.webUrl,
      restoredTables: dataTables,
      restoredVolumes: stores,
      sourceCheckoutDirty: manifest.sourceCheckoutDirty,
      sourceImages: manifest.images,
      target,
      testedHead: manifest.release,
    };
  } finally {
    if (passed) {
      // Each container was checked for the disposable ownership label before removal.
      await compose("down", "--volumes");
      await rm(tempDirectory, { recursive: true });
    } else {
      process.stderr.write(
        `Restore evidence retained: project ${target}, private snapshot ${directory}.\n`
      );
    }
  }
};
