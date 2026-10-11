import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { AwsClient } from "aws4fetch";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { parseRuntimeConfiguration } from "../apps/server/src/config.ts";
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

if (!["local", "production"].includes(mode)) {
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
const readRuntimeConfiguration = async () => {
  try {
    return await readFile(path.join(directory, "runtime.json"), "utf-8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    throw new Error(
      mode === "local"
        ? "No runtime.json. Set CEREBRO_MODEL_API_KEY in .env (see .env.example) and run pnpm start."
        : "Production requires runtime.json in the secrets directory.",
      { cause: error }
    );
  }
};
const runtimeConfiguration = parseRuntimeConfiguration(
  await readRuntimeConfiguration(),
  mode
);
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
    bindings: [{ class_name: "SessionAgent", name: "SESSION" }],
  },
  main: "apps/server/src/index.ts",
  // Applied migration tags are history. celld cannot delete classes, so the
  // retired SessionFixture, ChannelDispatcher, and GatewayJournal stay named
  // here but unexported.
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
    RUNTIME_CONFIG_JSON: runtimeConfigurationJson,
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
