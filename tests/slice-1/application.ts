/* oxlint-disable no-await-in-loop -- Fixture state and process checkpoints must be observed in order. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { z } from "zod";

const executeFile = promisify(execFile);
const execute = (
  command: string,
  args: readonly string[],
  options: ExecFileOptions = {}
) =>
  executeFile("rtk", ["proxy", command, ...args], {
    ...options,
    encoding: "utf-8",
  });
const root = path.resolve(import.meta.dirname, "../..");
// Production compose.yaml plus the test-only fake provider and seed services.
export const stackFiles = [
  path.join(root, "compose.yaml"),
  path.join(root, "tests/slice-1/compose.test.yaml"),
];
const localUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    );
  });
const bootSchema = z.object({
  apiUrl: localUrl,
  fixtureId: z.string().regex(/^cerebro-s1-[a-z0-9_-]+$/u),
  fixtureUrl: localUrl,
  mode: z.literal("application"),
  overridePath: z.string(),
  sha: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceCheckoutDirty: z.boolean(),
  webUrl: localUrl,
});
export type ApplicationBoot = z.infer<typeof bootSchema>;

export const freeFixturePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
};

export const readApplicationBoot = async (
  file: string
): Promise<ApplicationBoot> => {
  const boot = bootSchema.parse(JSON.parse(await readFile(file, "utf-8")));
  const health = await fetch(`${boot.fixtureUrl}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(health.status, 200);
  const identity = z
    .object({ fixtureId: z.string(), sha: z.string() })
    .parse(await health.json());
  assert.equal(identity.fixtureId, boot.fixtureId);
  assert.equal(identity.sha, boot.sha);
  return boot;
};

export const bootApplication = async (
  name: string
): Promise<ApplicationBoot> => {
  assert.match(name, /^[a-z][a-z0-9-]*$/u);
  const ports = new Set<number>();
  while (ports.size < 3) {
    ports.add(await freeFixturePort());
  }
  const [api, web, fixture] = [...ports];
  const project = `cerebro-s1-${name}-${randomUUID().slice(0, 8)}`;
  const revision = await execute("git", ["rev-parse", "HEAD"], { cwd: root });
  const sha = revision.stdout.trim();
  await execute(
    process.execPath,
    [
      "tests/slice-1/boot.mjs",
      "--project",
      project,
      "--api-port",
      String(api),
      "--web-port",
      String(web),
      "--fixture-port",
      String(fixture),
    ],
    { cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60_000 }
  );
  return readApplicationBoot(
    path.join(root, "artifacts/slice-1", sha, project, "boot.json")
  );
};

export const applicationFixture = (boot: ApplicationBoot) => {
  const container = async (service: string): Promise<string> => {
    const listed = await execute("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${boot.fixtureId}`,
      "--filter",
      `label=com.docker.compose.service=${service}`,
    ]);
    const ids = listed.stdout.trim().split("\n").filter(Boolean);
    assert.equal(ids.length, 1, `Expected one owned ${service} container`);
    const [containerId] = ids;
    assert.ok(containerId);
    const inspected = await execute("docker", ["inspect", containerId]);
    const [metadata] = JSON.parse(inspected.stdout);
    assert.equal(metadata.Config.Labels["cerebro.slice-1"], "disposable");
    return containerId;
  };
  const request = (
    route: string,
    cookie: string,
    body?: unknown,
    method?: string
  ) => {
    assert.ok(route.startsWith("/"));
    return fetch(`${boot.apiUrl}${route}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: boot.webUrl,
      },
      method: method ?? (body === undefined ? "GET" : "POST"),
      signal: AbortSignal.timeout(30_000),
    });
  };
  const json = async <Value>(
    route: string,
    cookie: string,
    schema: z.ZodType<Value>,
    body?: unknown,
    method?: string
  ): Promise<Value> => {
    const response = await request(route, cookie, body, method);
    assert.equal(response.status, 200, `${route}: HTTP ${response.status}`);
    return schema.parse(await response.json());
  };
  const sql = async (statement: string): Promise<string> => {
    const result = await execute(
      "docker",
      [
        "exec",
        await container("postgres"),
        "psql",
        "-U",
        "cerebro",
        "-d",
        "cerebro",
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-c",
        statement,
      ],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    return result.stdout.trim();
  };
  const signup = async (name = "S1-F fixture user") => {
    const email = `slice-1-${randomUUID()}@example.test`;
    const password = `${randomUUID()}${randomUUID()}`;
    const response = await request("/api/auth/sign-up/email", "", {
      email,
      name,
      password,
    });
    assert.equal(response.status, 200, "Fixture signup failed");
    const body = z
      .object({ user: z.object({ id: z.string() }) })
      .parse(await response.json());
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.ok(cookie.includes("session_token"));
    return { cookie, email, password, userId: body.user.id };
  };
  // Local deployments require the generated installation token for setup.
  const bootstrapToken = async (): Promise<string> => {
    const result = await execute("docker", [
      "exec",
      await container("fixture"),
      "cat",
      "/run/cerebro-secrets/bootstrap-token",
    ]);
    return result.stdout.trim();
  };
  const controls = async (body: unknown) => {
    const response = await fetch(`${boot.fixtureUrl}/control`, {
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        "X-Fixture-Control": "slice-1-control",
      },
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    await response.body?.cancel();
  };
  const observations = async (): Promise<unknown> => {
    const response = await fetch(`${boot.fixtureUrl}/observations`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const close = async (): Promise<void> => {
    await execute(
      process.execPath,
      [
        "tests/slice-1/boot.mjs",
        "--project",
        boot.fixtureId,
        "--state-sha",
        boot.sha,
        "--api-port",
        new URL(boot.apiUrl).port,
        "--web-port",
        new URL(boot.webUrl).port,
        "--fixture-port",
        new URL(boot.fixtureUrl).port,
        "--down",
      ],
      { cwd: root, timeout: 30_000 }
    );
  };
  return {
    boot,
    bootstrapToken,
    close,
    container,
    controls,
    json,
    observations,
    request,
    signup,
    sql,
  };
};

const pilotDocument =
  "Fixture refund policy: refunds require current company authorization. Cerebro pilot runs use current company grants before each model request and tool dispatch. The local pilot source is stored in PostgreSQL and MinIO. Source revocation removes its content from later answers and source views.";
const sqlLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

export const initializeFixtureAgent = async (
  fixture: ReturnType<typeof applicationFixture>,
  owner: { readonly cookie: string; readonly userId: string },
  model = "fixture/slice-1"
) => {
  const setup = await fixture.json(
    "/api/product/setup",
    owner.cookie,
    z.object({ organizationId: z.string(), owner: z.literal(true) }),
    {
      bootstrapToken: await fixture.bootstrapToken(),
      operationId: randomUUID(),
    }
  );
  const principalId = await fixture.sql(
    `SELECT id FROM identity_principal WHERE organization_id=${sqlLiteral(setup.organizationId)} AND better_auth_user_id=${sqlLiteral(owner.userId)}`
  );
  assert.ok(principalId && !principalId.includes("\n"));
  const resources = [
    ["read", "memory", "pilot-source"],
    ["write", "memory", "pilot-source"],
    ["read", "tool", "fixture-read"],
    ["execute", "tool", "fixture-read"],
    ["read", "tool", "fixture_effect"],
    ["execute", "tool", "fixture_effect"],
    ["write", "tool", "fixture_effect"],
    ["approve", "tool", "fixture_effect"],
    ["execute", "tool", "fixture-connector"],
  ] as const;
  for (const [action, kind, resource] of resources) {
    await fixture.sql(
      `INSERT INTO identity_grant (organization_id,principal_id,action,resource_kind,resource_id,source) VALUES (${[setup.organizationId, principalId, action, kind, resource, "slice-1-fixture"].map(sqlLiteral).join(",")}) ON CONFLICT DO NOTHING`
    );
  }
  // The pilot source is ordinary company memory, ingested through the API.
  await fixture.json(
    "/rpc/memory/ingest",
    owner.cookie,
    z.object({ json: z.object({ status: z.literal("ok") }) }),
    {
      json: {
        operationId: `seed:${setup.organizationId}:pilot-source:1`,
        organizationId: setup.organizationId,
        requestDigest: "sha256:pilot-source-1",
        source: {
          chunks: [{ id: "pilot-source:1:policy", text: pilotDocument }],
          document: pilotDocument,
          expectedGeneration: null,
          observedAt: 1_790_720_000_000,
          sourceId: "pilot-source",
          uri: "cerebro://pilot/source",
          version: "1",
          visibility: { kind: "organization" },
        },
      },
    }
  );
  const agent = await fixture.json(
    "/api/product/agents",
    owner.cookie,
    z.object({ agentId: z.string(), version: z.number() }),
    {
      enabledToolIds: ["fixture-read", "fixture_effect"],
      grants: resources.map(([action, kind, resource]) => ({
        action,
        resource: { id: resource, kind, organizationId: setup.organizationId },
      })),
      instructions:
        "Answer from the supplied sources. Use fixture-read when requested. Use fixture_effect only when the user requests the write fixture.",
      model,
      name: "Slice 1 acceptance",
      operationId: randomUUID(),
    }
  );
  return { ...agent, organizationId: setup.organizationId, principalId };
};

export const waitForFixture = async <Value>(
  read: () => Value | Promise<Value>,
  ready: (value: Value) => boolean,
  timeoutMs = 30_000
): Promise<Value> => {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!ready(latest) && Date.now() < deadline) {
    await delay(50);
    latest = await read();
  }
  assert.ok(
    ready(latest),
    "Fixture state did not reach the required condition before its deadline"
  );
  return latest;
};
