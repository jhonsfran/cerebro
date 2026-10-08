import { parseRuntimeConfiguration } from "../apps/server/src/runtime-configuration.ts";

export const fixtureRuntimeConfiguration = (secret: string) =>
  parseRuntimeConfiguration(
    JSON.stringify({
      artifacts: {
        accessKeyId: "cerebro",
        bucket: "cerebro-artifacts",
        endpoint: "http://minio-artifacts:9000",
        region: "us-east-1",
        secretAccessKey: secret,
      },
      gatewaySigningKey: secret,
      mode: "fixture",
      models: [
        {
          apiKey: "fixture-model-key",
          baseUrl: "http://fixture:8090/v1",
          deadlineMs: 60_000,
          id: "fixture/slice-1",
          maxInputBytes: 131_072,
          maxOutputTokens: 2048,
          model: "slice-1",
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
          description: "Read the isolated fixture",
          effect: "read",
          id: "fixture-read",
          inputSchema: {
            additionalProperties: false,
            properties: { query: { type: "string" } },
            required: ["query"],
            type: "object",
          },
          maxInputBytes: 4096,
          maxOutputBytes: 16_384,
          outputSchema: { type: "object" },
          requiresApproval: false,
          retryMode: "idempotent",
          target: {
            kind: "mcp-read",
            method: "fixture-read",
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
          description: "Write once after approval",
          effect: "write",
          id: "fixture_effect",
          inputSchema: {
            additionalProperties: false,
            properties: { value: { type: "string" } },
            required: ["value"],
            type: "object",
          },
          maxInputBytes: 4096,
          maxOutputBytes: 16_384,
          outputSchema: { type: "object" },
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
    "fixture"
  );
