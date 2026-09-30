import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { AwsClient } from "aws4fetch";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { build } from "esbuild";
import postgres from "postgres";

import { parseRuntimeConfiguration } from "../apps/server/src/runtime-configuration.ts";
import { parseEnterpriseIdentityJSON } from "../packages/auth/src/enterprise.ts";

const directory = process.env.CEREBRO_SECRETS_DIR ?? "/run/cerebro-secrets";
const mode = process.env.DEPLOY_MODE ?? "local";
const authSecretFile = await readFile(
  path.join(directory, "auth-secret"),
  "utf-8"
);
const postgresPasswordFile = await readFile(
  path.join(directory, "postgres-password"),
  "utf-8"
);
const minioPasswordFile = await readFile(
  path.join(directory, "minio-password"),
  "utf-8"
);
const authSecret = authSecretFile.trim();
const postgresPassword = postgresPasswordFile.trim();
const minioPassword = minioPasswordFile.trim();
const localDatabaseUrl = `postgres://cerebro:${encodeURIComponent(postgresPassword)}@postgres:5432/cerebro`;
const databaseUrl = process.env.CEREBRO_DATABASE_URL || localDatabaseUrl;
const authUrl = process.env.CEREBRO_PUBLIC_API_URL ?? "http://localhost:18765";
const webUrl = process.env.CEREBRO_PUBLIC_WEB_URL ?? "http://localhost:3001";
let enterpriseIdentityJson;
let enterpriseIdentity;
try {
  const identityConfigFile = await readFile(
    path.join(directory, "enterprise-identity.json"),
    "utf-8"
  );
  enterpriseIdentityJson = identityConfigFile.trim();
  if (!enterpriseIdentityJson) {
    throw new Error("Enterprise identity configuration is empty");
  }
  enterpriseIdentity = parseEnterpriseIdentityJSON(enterpriseIdentityJson);
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}

let channelConfig;
try {
  channelConfig = JSON.parse(
    await readFile(path.join(directory, "channels.json"), "utf-8")
  );
  if (
    typeof channelConfig.organizationId !== "string" ||
    !channelConfig.organizationId.trim()
  ) {
    throw new Error("Channel configuration needs an organization ID");
  }
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}

if (!["local", "fixture", "production"].includes(mode)) {
  throw new Error("Invalid deployment mode");
}
if (mode === "production") {
  if (
    !process.env.CEREBRO_DATABASE_URL ||
    new URL(databaseUrl).searchParams.get("sslmode") !== "verify-full"
  ) {
    throw new Error("Production requires sslmode=verify-full");
  }
  if (
    new URL(authUrl).protocol !== "https:" ||
    new URL(webUrl).protocol !== "https:"
  ) {
    throw new Error("Production public URLs must use HTTPS");
  }
}

const organizationId =
  channelConfig?.organizationId ??
  enterpriseIdentity?.organizationId ??
  "local-company";
const objectSchema = (properties, required) => ({
  additionalProperties: false,
  properties,
  required,
  type: "object",
});
const toolOutput = objectSchema(
  {
    operationId: { type: "string" },
    receipt: { type: "string" },
    value: { type: "string" },
  },
  ["value", "operationId", "receipt"]
);
let runtimeConfiguration;
try {
  runtimeConfiguration = parseRuntimeConfiguration(
    await readFile(path.join(directory, "runtime.json"), "utf-8"),
    mode
  );
} catch (error) {
  if (error.code !== "ENOENT" || mode === "production") {
    throw new Error(
      "An explicit valid runtime.json is required for this deployment.",
      { cause: error }
    );
  }
  if (mode === "local") {
    const bootstrapToken = await readFile(
      path.join(directory, "bootstrap-token"),
      "utf-8"
    );
    runtimeConfiguration = parseRuntimeConfiguration(
      JSON.stringify({
        artifacts: {
          accessKeyId: "cerebro",
          bucket: "cerebro-artifacts",
          endpoint: "http://minio-artifacts:9000",
          region: "us-east-1",
          secretAccessKey: minioPassword,
        },
        bootstrapToken: bootstrapToken.trim(),
        budget: { initialUnits: 0, kind: "local", unit: "usd-micro" },
        gatewaySigningKey: createHmac("sha256", authSecret)
          .update("cerebro-pilot-tool-gateway-v1")
          .digest("hex"),
        mode,
        models: ["space-bunny-free"].map((model) => ({
          apiKey: "public",
          baseUrl: "https://opencode.ai/zen/v1",
          deadlineMs: 90_000,
          id: `opencode/${model}`,
          maxInputBytes: 65_536,
          maxOutputTokens: 8192,
          maxRequestsPerRun: 8,
          maxResponseBytes: 1_048_576,
          model,
          pricing: {
            inputPerToken: 0,
            outputPerToken: 0,
            unit: "usd-micro",
            version: "opencode-free-2026-09-30",
          },
          provider: "opencode",
        })),
        retrievalMode: "full-text",
        tools: [],
      }),
      mode
    );
  }
  if (mode === "fixture") {
    runtimeConfiguration = parseRuntimeConfiguration(
      JSON.stringify({
        artifacts: {
          accessKeyId: "cerebro",
          bucket: "cerebro-artifacts",
          endpoint: "http://minio-artifacts:9000",
          region: "us-east-1",
          secretAccessKey: minioPassword,
        },
        budget: { initialUnits: 1_000_000, kind: "local", unit: "pilot-units" },
        gatewaySigningKey: createHmac("sha256", authSecret)
          .update("cerebro-pilot-tool-gateway-v1")
          .digest("hex"),
        mode,
        models: [
          {
            apiKey: "fixture-model-key",
            baseUrl: "http://fixture:8090/v1",
            deadlineMs: 30_000,
            id: "fixture/pilot",
            maxInputBytes: 16_384,
            maxOutputTokens: 2048,
            maxRequestsPerRun: 16,
            maxResponseBytes: 65_536,
            model: "pilot",
            pricing: {
              inputPerToken: 1,
              outputPerToken: 1,
              unit: "pilot-units",
              version: "fixture-pricing-v1",
            },
            provider: "fixture",
          },
        ],
        retrievalMode: "full-text",
        tools: [
          {
            connectorId: "fixture-connector",
            credentials: {
              headers: { Authorization: "Bearer fixture-connector-key" },
              secrets: ["fixture-connector-key"],
            },
            description: "Read the controlled pilot connector.",
            effect: "read",
            id: "fixture-read",
            inputSchema: objectSchema({ query: { type: "string" } }, ["query"]),
            maxInputBytes: 4096,
            maxOutputBytes: 8192,
            outputSchema: toolOutput,
            requiresApproval: false,
            retryMode: "reconcile-only",
            target: {
              kind: "mcp-read",
              method: "pilot_read",
              url: "https://fixture.invalid/mcp",
            },
            version: "1",
          },
          {
            connectorId: "fixture-connector",
            credentials: {
              headers: { Authorization: "Bearer fixture-connector-key" },
              secrets: ["fixture-connector-key"],
            },
            description: "Apply one controlled pilot effect after approval.",
            effect: "write",
            id: "fixture_effect",
            inputSchema: objectSchema(
              { value: { const: "approved-fixture", type: "string" } },
              ["value"]
            ),
            maxInputBytes: 4096,
            maxOutputBytes: 8192,
            outputSchema: toolOutput,
            requiresApproval: true,
            retryMode: "reconcile-only",
            target: {
              kind: "fixture-write",
              method: "fixture_effect",
              url: "https://fixture.invalid/effects",
            },
            version: "1",
          },
        ],
      }),
      mode
    );
  }
}
const runtimeConfigurationJson = JSON.stringify(runtimeConfiguration);

const aws = new AwsClient({
  accessKeyId: "cerebro",
  region: "us-east-1",
  secretAccessKey: minioPassword,
  service: "s3",
});
await Promise.all(
  [
    ["minio-runtime", "cerebro-runtime"],
    ["minio-artifacts", "cerebro-artifacts"],
  ].map(async ([host, bucket]) => {
    const response = await aws.fetch(`http://${host}:9000/${bucket}`, {
      method: "PUT",
    });
    const body = await response.text();
    if (
      !response.ok &&
      !(response.status === 409 && body.includes("BucketAlreadyOwnedByYou"))
    ) {
      throw new Error(
        `Bucket initialization failed at ${host} with status ${response.status}`
      );
    }
  })
);

const client = postgres(databaseUrl, {
  connect_timeout: 5,
  max: 1,
  prepare: false,
});
try {
  await migrate(drizzle(client), {
    migrationsFolder: new URL("../packages/db/src/migrations", import.meta.url)
      .pathname,
  });
  await client`INSERT INTO organization (id, name) VALUES (${organizationId}, ${organizationId}) ON CONFLICT (id) DO NOTHING`;
  await client`INSERT INTO usage_account (organization_id, unit, total, available) VALUES (${organizationId}, ${runtimeConfiguration.budget.unit}, ${runtimeConfiguration.budget.initialUnits}, ${runtimeConfiguration.budget.initialUnits}) ON CONFLICT (organization_id, unit) DO NOTHING`;
  if (mode === "fixture") {
    const seederId = `pilot-source-seeder:${organizationId}`;
    await client`INSERT INTO identity_principal (id, organization_id, kind, state) VALUES (${seederId}, ${organizationId}, 'service', 'active') ON CONFLICT (id) DO NOTHING`;
    await client`INSERT INTO identity_grant (organization_id, principal_id, action, resource_kind, resource_id, source) VALUES (${organizationId}, ${seederId}, 'write', 'memory', 'pilot-source', 'fixture-source-seeder') ON CONFLICT DO NOTHING`;
    const seedBundle = path.join(process.cwd(), "deploy", ".pilot-source.mjs");
    await build({
      bundle: true,
      entryPoints: ["deploy/seed-fixture.ts"],
      external: ["postgres"],
      format: "esm",
      nodePaths: [path.join(process.cwd(), "apps/server/node_modules")],
      outfile: seedBundle,
      platform: "node",
    });
    const { seedFixtureSource } = await import(seedBundle);
    await seedFixtureSource(
      databaseUrl,
      organizationId,
      runtimeConfiguration.artifacts
    );
    await unlink(seedBundle);
  }
  if (enterpriseIdentity) {
    try {
      await client`
        INSERT INTO organization (id, name)
        VALUES (${enterpriseIdentity.organizationId}, ${enterpriseIdentity.domain})
        ON CONFLICT (id) DO NOTHING
      `;
    } catch (error) {
      throw new Error("Could not initialize the enterprise organization", {
        cause: error,
      });
    }
  }
} finally {
  await client.end({ timeout: 2 });
}

const config = {
  compatibility_date: "2026-09-28",
  compatibility_flags: ["nodejs_compat"],
  durable_objects: {
    bindings: [
      { class_name: "SessionFixture", name: "SESSION_FIXTURE" },
      { class_name: "ChannelDispatcher", name: "CHANNEL_DISPATCHER" },
      { class_name: "SessionAgent", name: "SESSION" },
      { class_name: "GatewayJournal", name: "GATEWAY_JOURNAL" },
    ],
  },
  main: "apps/server/src/index.ts",
  migrations: [
    { new_sqlite_classes: ["SessionFixture"], tag: "v1" },
    { new_sqlite_classes: ["ChannelDispatcher"], tag: "v2" },
    { new_sqlite_classes: ["SessionAgent", "GatewayJournal"], tag: "v3" },
  ],
  name: "cerebro-api",
  services: [
    {
      binding: "TOOL_GATEWAY",
      entrypoint: "TrustedGateway",
      service: "cerebro-api",
    },
    { binding: "AUDIT_SINK", entrypoint: "AuditSink", service: "cerebro-api" },
  ],
  vars: {
    BETTER_AUTH_SECRET: authSecret,
    BETTER_AUTH_URL: authUrl,
    CHANNEL_ORGANIZATION_ID:
      channelConfig?.organizationId ??
      enterpriseIdentity?.organizationId ??
      "local-company",
    CORS_ORIGIN: webUrl,
    DATABASE_URL: databaseUrl,
    DEPLOY_MODE: mode,
    FIXTURE_ADAPTERS: mode === "fixture" ? "1" : "0",
    FIXTURE_URL: "http://fixture:8090",
    RUNTIME_CONFIG_JSON: runtimeConfigurationJson,
    TOOL_EFFECT_MODE: "idempotent",
    ...(channelConfig?.slack
      ? { SLACK_CHANNEL_JSON: JSON.stringify(channelConfig.slack) }
      : {}),
    ...(enterpriseIdentityJson
      ? { ENTERPRISE_IDENTITY_JSON: enterpriseIdentityJson }
      : {}),
  },
  worker_loaders: [{ binding: "LOADER" }],
};
const configPath = path.join(process.cwd(), "wrangler.jsonc");
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
});
try {
  const deployment = spawnSync(
    "celld",
    [
      "deploy",
      ".",
      "--bucket",
      "s3://cerebro-runtime",
      "--endpoint",
      "http://minio-runtime:9000",
      "--region",
      "us-east-1",
    ],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: "cerebro",
        AWS_REGION: "us-east-1",
        AWS_SECRET_ACCESS_KEY: minioPassword,
      },
      maxBuffer: 10 * 1024 * 1024,
    }
  );
  let output = `${deployment.stdout ?? ""}${deployment.stderr ?? ""}`
    .replaceAll(authSecret, "[secret removed]")
    .replaceAll(minioPassword, "[secret removed]")
    .replaceAll(postgresPassword, "[secret removed]")
    .replaceAll(databaseUrl, "[database URL removed]")
    .replaceAll(runtimeConfigurationJson, "[runtime configuration removed]");
  for (const secret of [
    runtimeConfiguration.artifacts.secretAccessKey,
    runtimeConfiguration.gatewaySigningKey,
    ...runtimeConfiguration.models.map((model) => model.apiKey),
    ...runtimeConfiguration.tools.flatMap((tool) => tool.credentials.secrets),
    runtimeConfiguration.bootstrapToken,
  ].filter(Boolean)) {
    output = output.replaceAll(secret, "[runtime secret removed]");
  }
  if (enterpriseIdentityJson) {
    output = output.replaceAll(
      enterpriseIdentityJson,
      "[enterprise identity removed]"
    );
  }
  process.stdout.write(output);
  if (deployment.error) {
    throw deployment.error;
  }
  if (deployment.status !== 0) {
    throw new Error("Native celld deployment failed");
  }
} finally {
  await unlink(configPath);
}
