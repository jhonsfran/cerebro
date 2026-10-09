import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { WorkerEnv } from "../../apps/server/src/env.server";
import app from "../../apps/server/src/index";

const environment: WorkerEnv = {
  BETTER_AUTH_SECRET: "a".repeat(32),
  BETTER_AUTH_URL: "http://localhost:18765",
  CORS_ORIGIN: "http://localhost:3001",
  DATABASE_URL: "postgres://user:pass@localhost:5432/cerebro",
  DEPLOY_MODE: "local",
};

test("readiness reports invalid enterprise authentication configuration", async () => {
  const response = await app.request(
    "/ready",
    {},
    {
      ...environment,
      ENTERPRISE_IDENTITY_JSON: "{}",
    }
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Authentication configuration invalid",
    ok: false,
  });
});

test("readiness reports invalid Worker authentication settings", async () => {
  const response = await app.request(
    "/ready",
    {},
    {
      ...environment,
      BETTER_AUTH_SECRET: "short",
    }
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Configuration invalid",
    ok: false,
  });
});

test("bootstrap rejects semantic enterprise configuration before deployment", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cerebro-bootstrap-"));
  try {
    await Promise.all([
      writeFile(
        path.join(directory, "auth-secret"),
        randomBytes(32).toString("hex")
      ),
      writeFile(path.join(directory, "postgres-password"), "postgres-password"),
      writeFile(path.join(directory, "minio-password"), "minio-password"),
      writeFile(
        path.join(directory, "enterprise-identity.json"),
        JSON.stringify({
          clientId: "client-a",
          clientSecret: "secret-a",
          domain: "example.test",
          groupRoles: {},
          issuer: "http://login.example.test/tenant-a/v2.0",
          organizationId: "company-a",
          providerId: "entra",
          scimBearerToken: "token-a",
          scimConnectionId: "scim-a",
          tenantId: "tenant-a",
        })
      ),
    ]);
    const result = spawnSync("node", ["deploy/bootstrap.mjs"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: {
        ...process.env,
        CEREBRO_SECRETS_DIR: directory,
        DEPLOY_MODE: "local",
      },
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Enterprise issuer must use HTTPS/u);
    assert.doesNotMatch(result.stderr, /Bucket initialization failed/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
