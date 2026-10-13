// Writes the local runtime.json that points Cerebro at the fake model and
// connectors in provider.mjs. Production deployments supply their own file.
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const directory = process.env.CEREBRO_SECRETS_DIR ?? "/run/cerebro-secrets";
const secret = async (name) => {
  const value = await readFile(path.join(directory, name), "utf-8");
  return value.trim();
};
const minioPassword = await secret("minio-password");
const connector = {
  connectorId: "fixture-connector",
  credentials: {
    headers: { Authorization: "Bearer fixture-connector-key" },
    secrets: ["fixture-connector-key"],
  },
  maxInputBytes: 4096,
  maxOutputBytes: 16_384,
  outputSchema: { type: "object" },
  version: "1",
};
const configuration = {
  artifacts: {
    accessKeyId: "cerebro",
    bucket: "cerebro-artifacts",
    endpoint: "http://minio-artifacts:9000",
    region: "us-east-1",
    secretAccessKey: minioPassword,
  },
  bootstrapToken: await secret("bootstrap-token"),
  connectors: [
    {
      credentials: connector.credentials,
      id: "fixture-mcp",
      url: "http://fixture:8090/mcp",
    },
  ],
  gatewaySigningKey: minioPassword,
  mode: "local",
  models: [
    {
      apiKey: "fixture-model-key",
      baseUrl: "http://fixture:8090/v1",
      deadlineMs: 60_000,
      id: "fixture/slice-1",
      maxInputBytes: 131_072,
      maxOutputTokens: 2048,
      maxResponseBytes: 1_048_576,
      model: "slice-1",
      provider: "fixture",
    },
  ],
  retrievalMode: "full-text",
  tools: [
    {
      ...connector,
      description: "Read the isolated fixture",
      effect: "read",
      id: "fixture-read",
      inputSchema: {
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
        type: "object",
      },
      requiresApproval: false,
      retryMode: "idempotent",
      target: {
        kind: "mcp",
        method: "fixture-read",
        url: "http://fixture:8090/mcp",
      },
    },
    {
      ...connector,
      description: "Write once after approval",
      effect: "write",
      id: "fixture_effect",
      inputSchema: {
        additionalProperties: false,
        properties: { value: { type: "string" } },
        required: ["value"],
        type: "object",
      },
      requiresApproval: true,
      retryMode: "at-most-once",
      target: {
        kind: "http-write",
        method: "fixture_effect",
        url: "http://fixture:8090/effects",
      },
    },
  ],
};
const file = path.join(directory, "runtime.json");
await writeFile(`${file}.tmp`, JSON.stringify(configuration), { mode: 0o600 });
await rename(`${file}.tmp`, file);
process.stdout.write("Test runtime configuration is ready\n");
