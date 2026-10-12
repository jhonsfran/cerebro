import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { assertWorkerEnv } from "../../apps/server/src/bindings.ts";
import type { WorkerEnv } from "../../apps/server/src/bindings.ts";

const exec = promisify(execFile);
const project = `cerebro-boot-${randomBytes(4).toString("hex")}`;
// Production compose.yaml plus the test-only fake model provider.
const compose = [
  "compose",
  "-p",
  project,
  "-f",
  "compose.yaml",
  "-f",
  "tests/slice-1/compose.test.yaml",
];

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
    ACCOUNT_KEY: "k".repeat(32),
    BETTER_AUTH_SECRET: "a".repeat(32),
    BETTER_AUTH_URL: "https://api.example.test",
    CORS_ORIGIN: "https://web.example.test",
    DATABASE_URL: "postgres://user:pass@db.example.test/app?sslmode=require",
    DEPLOY_MODE: "production",
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

test("fresh Compose boot preserves an auth user, a conversation, and an artifact", async () => {
  const apiPort = await freePort();
  const webPort = await freePort();
  const fixturePort = await freePort();
  const baseUrl = `http://localhost:${apiPort}`;
  const environment = {
    ...process.env,
    CEREBRO_API_PORT: String(apiPort),
    CEREBRO_DATABASE_URL: "",
    CEREBRO_DEPLOY_MODE: "local",
    CEREBRO_FIXTURE_ID: project,
    CEREBRO_FIXTURE_PORT: String(fixturePort),
    CEREBRO_PUBLIC_API_URL: baseUrl,
    CEREBRO_PUBLIC_WEB_URL: `http://localhost:${webPort}`,
    CEREBRO_WEB_PORT: String(webPort),
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

    const product = async (
      route: string,
      requestCookie: string,
      body?: unknown
    ): Promise<Response> =>
      await fetch(`${baseUrl}/api/product/${route}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          "Content-Type": "application/json",
          Cookie: requestCookie,
          Origin: environment.CEREBRO_PUBLIC_WEB_URL,
        },
        method: body === undefined ? "GET" : "POST",
      });
    const token = await docker(
      "run",
      "--rm",
      "--no-deps",
      "bootstrap",
      "node",
      "--input-type=module",
      "-e",
      'import {readFile} from "node:fs/promises";process.stdout.write(await readFile("/run/cerebro-secrets/bootstrap-token","utf8"))'
    );
    const setup = await product("setup", cookie, {
      bootstrapToken: token.stdout.trim(),
      operationId: "boot-setup",
    });
    assert.equal(setup.status, 200);
    const agent = await product("agents", cookie, {
      enabledToolIds: [],
      grants: [],
      instructions: "Answer briefly.",
      model: "fixture/slice-1",
      name: "Boot agent",
      operationId: "boot-agent",
    });
    assert.equal(agent.status, 200);
    const { agentId } = (await agent.json()) as { agentId: string };
    const created = await product("conversations", cookie, {
      agentId,
      operationId: "boot-conversation",
    });
    assert.equal(created.status, 200);
    const { conversationId } = (await created.json()) as {
      conversationId: string;
    };
    const conversationRoute = `conversations/${encodeURIComponent(conversationId)}`;
    const sent = await product(`${conversationRoute}/messages`, cookie, {
      eventId: "boot-message",
      text: "Hello from the boot check.",
    });
    assert.equal(sent.status, 200);
    interface View {
      snapshot: { runs: { state: string }[]; outputs: unknown[] };
    }
    const view = async (requestCookie = cookie): Promise<View> => {
      const response = await product(conversationRoute, requestCookie);
      assert.equal(response.status, 200);
      return (await response.json()) as View;
    };
    const settle = async (deadline: number): Promise<View> => {
      const current = await view();
      if (
        current.snapshot.runs[0]?.state === "completed" ||
        Date.now() >= deadline
      ) {
        return current;
      }
      await delay(250);
      return await settle(deadline);
    };
    const completed = await settle(Date.now() + 60_000);
    assert.equal(completed.snapshot.runs[0]?.state, "completed");
    assert.equal(completed.snapshot.outputs.length, 1);
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
    const foreign = await product(conversationRoute, otherCookie);
    assert.ok([403, 404].includes(foreign.status));
    await foreign.body?.cancel();
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
    const resumedView = await view();
    assert.deepEqual(resumedView.snapshot, completed.snapshot);
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
