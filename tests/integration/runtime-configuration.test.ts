import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRuntimeConfiguration } from "../../apps/server/src/runtime-configuration.ts";

const configured = () => ({
  artifacts: {
    accessKeyId: "test-user",
    bucket: "test-artifacts",
    endpoint: "http://minio-artifacts:9000",
    region: "us-east-1",
    secretAccessKey: "private-artifact-test-value",
  },
  bootstrapToken: "private-setup-test-value-with-32-characters",
  budget: { initialUnits: 1000, kind: "local", unit: "test-units" },
  gatewaySigningKey: "private-gateway-test-value-with-32-characters",
  mode: "production",
  models: [
    {
      apiKey: "private-provider-test-value",
      baseUrl: "https://provider.example.test/v1",
      deadlineMs: 30_000,
      id: "company/model",
      maxInputBytes: 16_384,
      maxOutputTokens: 2048,
      maxResponseBytes: 65_536,
      model: "model",
      pricing: {
        inputPerToken: 1,
        outputPerToken: 1,
        unit: "test-units",
        version: "test-v1",
      },
      provider: "company",
    },
  ],
  retrievalMode: "full-text",
  tools: [
    {
      connectorId: "company-mcp",
      credentials: {
        headers: { Authorization: "Bearer private-connector-test-value" },
        secrets: [],
      },
      description: "Read a test record",
      effect: "read",
      id: "read-record",
      inputSchema: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
      maxInputBytes: 1024,
      maxOutputBytes: 4096,
      outputSchema: { type: "object" },
      requiresApproval: false,
      retryMode: "idempotent",
      target: {
        kind: "mcp-read",
        method: "read_record",
        url: "https://mcp.example.test/rpc",
      },
      version: "1",
    },
  ],
});
const parse = (value: unknown) =>
  parseRuntimeConfiguration(JSON.stringify(value), "production");

test("production accepts bounded ports and registers connector credentials for redaction", () => {
  const result = parse(configured());
  assert.equal(result.models[0].id, "company/model");
  assert.equal(result.models[0].maxRequestsPerRun, 16);
  assert.deepEqual(result.tools[0].credentials.secrets, [
    "Bearer private-connector-test-value",
    "private-connector-test-value",
  ]);
});

test("production rejects fixture model, write connector and deployment mode selection", () => {
  const fixtureModel = configured();
  fixtureModel.models[0].id = "fixture/pilot";
  fixtureModel.models[0].provider = "fixture";
  fixtureModel.models[0].model = "pilot";
  assert.throws(() => parse(fixtureModel));
  const write = configured();
  write.tools[0].effect = "write";
  write.tools[0].requiresApproval = true;
  write.tools[0].target.kind = "fixture-write";
  write.tools[0].target.url = "http://fixture:8090/effect";
  assert.throws(() => parse(write));
  assert.throws(() => parse({ ...configured(), mode: "fixture" }));
  assert.throws(() => parse({ ...configured(), bootstrapToken: undefined }));
});

test("production rejects local, insecure and credential-bearing transport targets", () => {
  for (const baseUrl of [
    "http://provider.example.test/v1",
    "https://localhost/v1",
    "https://fixture/v1",
    "https://provider.invalid/v1",
    "https://user:private-provider-test-value@provider.example.test/v1",
    "https://provider.example.test/v1?key=private-provider-test-value",
  ]) {
    const value = configured();
    value.models[0].baseUrl = baseUrl;
    assert.throws(() => parse(value), {
      message: /Runtime configuration is invalid/u,
    });
  }
  const mcp = configured();
  mcp.tools[0].target.url = "http://mcp.example.test/rpc";
  assert.throws(() => parse(mcp));
});

test("production rejects unsafe reservations, unsupported adapters and conflicting connector credentials", () => {
  const overflow = configured();
  overflow.models[0].pricing.inputPerToken = Number.MAX_SAFE_INTEGER;
  assert.throws(() => parse(overflow));
  assert.throws(() => parse({ ...configured(), budget: { kind: "unprice" } }));
  assert.throws(() => parse({ ...configured(), decision: { kind: "jev" } }));
  assert.throws(() => parse({ ...configured(), retrievalMode: "semantic" }));
  const conflicting = configured();
  conflicting.tools.push({
    ...conflicting.tools[0],
    credentials: {
      headers: { Authorization: "Bearer different-private-value" },
      secrets: [],
    },
    id: "other-read",
  });
  assert.throws(() => parse(conflicting));
});
