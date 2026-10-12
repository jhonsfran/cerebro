import assert from "node:assert/strict";
import { test } from "node:test";

import {
  connectorCredentialImports,
  parseRuntimeConfiguration,
  withoutCredentials,
} from "../../apps/server/src/config.ts";

const configured = () => ({
  artifacts: {
    accessKeyId: "test-user",
    bucket: "test-artifacts",
    endpoint: "http://minio-artifacts:9000",
    region: "us-east-1",
    secretAccessKey: "private-artifact-test-value",
  },
  bootstrapToken: "private-setup-test-value-with-32-characters",
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
  assert.deepEqual(result.tools[0].credentials?.secrets, [
    "Bearer private-connector-test-value",
    "private-connector-test-value",
  ]);
});

test("connector credentials are imported once per connector and never reach the Worker", () => {
  const result = parse(configured());
  assert.deepEqual(connectorCredentialImports(result), [
    {
      connectorId: "company-mcp",
      credentials: {
        headers: { Authorization: "Bearer private-connector-test-value" },
        secrets: [
          "Bearer private-connector-test-value",
          "private-connector-test-value",
        ],
      },
    },
  ]);
  assert.equal(
    JSON.stringify(withoutCredentials(result)).includes(
      "private-connector-test-value"
    ),
    false
  );
  const imported = configured();
  Reflect.deleteProperty(imported.tools[0], "credentials");
  assert.deepEqual(connectorCredentialImports(parse(imported)), []);
});

test("production accepts approved HTTPS write connectors and rejects unknown modes", () => {
  const write = configured();
  write.tools[0].effect = "write";
  write.tools[0].requiresApproval = true;
  write.tools[0].retryMode = "at-most-once";
  write.tools[0].target.kind = "http-write";
  write.tools[0].target.url = "https://mcp.example.test/effects";
  assert.equal(parse(write).tools[0].target.kind, "http-write");
  assert.throws(() =>
    parse({
      ...write,
      tools: [{ ...write.tools[0], requiresApproval: false }],
    })
  );
  assert.throws(() =>
    parse({
      ...write,
      tools: [
        {
          ...write.tools[0],
          target: {
            ...write.tools[0].target,
            url: "http://fixture:8090/effect",
          },
        },
      ],
    })
  );
  assert.throws(() => parse({ ...configured(), mode: "fixture" }));
  assert.throws(() => parse({ ...configured(), bootstrapToken: undefined }));
});

test("production rejects local, insecure and credential-bearing transport targets", () => {
  for (const baseUrl of [
    "http://provider.example.test/v1",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
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

test("production rejects retired billing, unsupported adapters and conflicting connector credentials", () => {
  const pricing = configured();
  assert.throws(() =>
    parse({
      ...pricing,
      models: [{ ...pricing.models[0], pricing: { inputPerToken: 1 } }],
    })
  );
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

const parseLocal = (value: unknown) =>
  parseRuntimeConfiguration(JSON.stringify(value), "local");

test("local mode accepts HTTP and private providers and keeps trusted setup", () => {
  const local = { ...configured(), mode: "local" };
  local.models[0] = {
    ...local.models[0],
    apiKey: "public",
    baseUrl: "https://model.example.test/v1",
    id: "configured/custom-model",
    model: "custom-model",
    provider: "configured",
  };
  local.tools = [];

  const result = parseLocal(local);
  assert.equal(result.models[0].id, "configured/custom-model");
  assert.deepEqual(result.tools, []);
  assert.throws(() => parseLocal({ ...local, bootstrapToken: undefined }));
  assert.throws(() => parseLocal({ ...local, mode: "fixture" }));
  local.models[0].baseUrl = "http://fixture:8090/v1";
  assert.equal(parseLocal(local).models[0].baseUrl, "http://fixture:8090/v1");
});
