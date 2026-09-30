import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import { promisify } from "node:util";

import { assertWorkerEnv } from "../../apps/server/src/env.server.ts";
import type { WorkerEnv } from "../../apps/server/src/env.server.ts";

const exec = promisify(execFile);
const project = `cerebro-boot-${randomBytes(4).toString("hex")}`;
const compose = ["compose", "-p", project];

const freePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a local port");
  }
  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
};

test("production configuration requires verified PostgreSQL TLS", () => {
  const environment = {
    BETTER_AUTH_SECRET: "a".repeat(32),
    BETTER_AUTH_URL: "https://api.example.test",
    CORS_ORIGIN: "https://web.example.test",
    DATABASE_URL: "postgres://user:pass@db.example.test/app?sslmode=require",
    DEPLOY_MODE: "production",
    FIXTURE_ADAPTERS: "0",
    SESSION_FIXTURE: {} as DurableObjectNamespace,
  } satisfies WorkerEnv;
  assert.throws(() => assertWorkerEnv(environment), /sslmode=verify-full/u);
  assert.doesNotThrow(() =>
    assertWorkerEnv({
      ...environment,
      DATABASE_URL:
        "postgres://user:pass@db.example.test/app?sslmode=verify-full",
    })
  );
});

test("fresh Compose boot preserves an auth user, session, and artifact", async () => {
  const apiPort = await freePort();
  const webPort = await freePort();
  const baseUrl = `http://localhost:${apiPort}`;
  const environment = {
    ...process.env,
    CEREBRO_API_PORT: String(apiPort),
    CEREBRO_DEPLOY_MODE: "fixture",
    CEREBRO_PUBLIC_API_URL: baseUrl,
    CEREBRO_PUBLIC_WEB_URL: `http://localhost:${webPort}`,
    CEREBRO_WEB_PORT: String(webPort),
    COMPOSE_PROFILES: "fixture",
  };
  const docker = (...arguments_: string[]) =>
    exec("docker", [...compose, ...arguments_], {
      env: environment,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });

  let passed = false;
  try {
    await docker("up", "--build", "-d", "--wait");
    const ready = await fetch(`${baseUrl}/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ok: true });

    const email = `boot-${randomBytes(8).toString("hex")}@example.test`;
    const signup = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      body: JSON.stringify({
        email,
        name: "Boot User",
        password: randomBytes(24).toString("base64url"),
      }),
      headers: {
        "Content-Type": "application/json",
        Origin: environment.CEREBRO_PUBLIC_WEB_URL,
      },
      method: "POST",
    });
    assert.equal(signup.status, 200);
    const cookie = signup.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    assert.ok(cookie.includes("session_token"));
    const initialSession = await fetch(`${baseUrl}/api/auth/get-session`, {
      headers: { Cookie: cookie },
    });
    assert.equal(initialSession.status, 200);
    const initialAuth = await initialSession.json();
    assert.equal(initialAuth.user.email, email);

    const name = `boot-${randomBytes(8).toString("hex")}`;
    const created = await fetch(`${baseUrl}/fixture/sessions/${name}`, {
      headers: { Cookie: cookie },
      method: "POST",
    });
    assert.equal(created.status, 201);
    const createdSession = await created.json();
    assert.equal(createdSession.userId, initialAuth.user.id);
    const otherSignup = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      body: JSON.stringify({
        email: `other-${randomBytes(8).toString("hex")}@example.test`,
        name: "Other User",
        password: randomBytes(24).toString("base64url"),
      }),
      headers: {
        "Content-Type": "application/json",
        Origin: environment.CEREBRO_PUBLIC_WEB_URL,
      },
      method: "POST",
    });
    assert.equal(otherSignup.status, 200);
    const otherCookie = otherSignup.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    const otherSession = await fetch(`${baseUrl}/fixture/sessions/${name}`, {
      headers: { Cookie: otherCookie },
    });
    assert.equal(otherSession.status, 404);
    const artifactKey = `boot-${randomBytes(8).toString("hex")}`;
    const artifact = await docker(
      "run",
      "--rm",
      "--no-deps",
      "bootstrap",
      "node",
      "deploy/artifact-probe.mjs",
      "write",
      artifactKey
    );
    assert.equal(artifact.stdout.trim(), `artifact-${artifactKey}`);

    await docker("down");
    await docker("up", "-d", "--wait");

    const resumedAuth = await fetch(`${baseUrl}/api/auth/get-session`, {
      headers: { Cookie: cookie },
    });
    assert.equal(resumedAuth.status, 200);
    const resumedAuthBody = await resumedAuth.json();
    assert.equal(resumedAuthBody.user.email, email);
    const resumedSession = await fetch(`${baseUrl}/fixture/sessions/${name}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(resumedSession.status, 200);
    assert.deepEqual(await resumedSession.json(), createdSession);
    const restoredArtifact = await docker(
      "run",
      "--rm",
      "--no-deps",
      "bootstrap",
      "node",
      "deploy/artifact-probe.mjs",
      "read",
      artifactKey
    );
    assert.equal(restoredArtifact.stdout.trim(), `artifact-${artifactKey}`);
    passed = true;
  } finally {
    if (passed) {
      await docker("down", "--volumes");
    } else {
      process.stderr.write(
        `Boot containers and state retained in Compose project ${project}\n`
      );
    }
  }
});
