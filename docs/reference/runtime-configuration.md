# Runtime configuration

`runtime.json` configures the models, tools, and storage that one installation uses. `deploy/bootstrap.mjs` reads it from the secrets directory, validates it with `parseRuntimeConfiguration` in `apps/server/src/config.ts`, and publishes it to the Worker as `RUNTIME_CONFIG_JSON`. The Worker parses it once per isolate. A change takes effect the next time bootstrap runs. Bootstrap writes `tools` to the tool catalog in PostgreSQL and seals their `credentials` into connector accounts. The Worker receives the file without tools and reads them from the catalog.

In local mode, `pnpm start` writes this file from the model settings in `.env` (`deploy/local-runtime.mjs`). In production you supply it. The file contains credentials. Do not commit it.

Unknown fields are rejected.

## Top-level fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `mode` | `"local"` or `"production"` | yes | Must match `DEPLOY_MODE`. |
| `models` | array of [models](#models) | yes | At least one. Model IDs are unique. |
| `tools` | array of [tools](#tools) | yes | The catalog tools this file owns. Each start replaces them, so removing a tool here removes it from the catalog. Conversations started after the change see it. An empty array removes them all. |
| `connectors` | array of [MCP connectors](#mcp-connectors) | no | MCP servers whose tools bootstrap discovers into the catalog. |
| `artifacts` | object | yes | `endpoint`, `bucket`, `accessKeyId`, `secretAccessKey`, and `region` of the artifact MinIO or S3 store. |
| `gatewaySigningKey` | string | yes | At least 32 characters. Signs requests from the API to session objects. |
| `retrievalMode` | `"full-text"` | yes | The only supported value. |
| `bootstrapToken` | string | one of two | At least 32 characters. Lets the first user who presents it become the installation owner. |
| `trustedOwnerUserId` | string | one of two | A Better Auth user ID that may become the owner without a token. |

At least one of `bootstrapToken` and `trustedOwnerUserId` is required.

## Models

Every model uses the OpenAI-compatible chat completions API.

Pi owns run execution. The old `maxRequestsPerRun` field never limited requests. The parser removes it from older files; new configurations should omit it. `maxResponseBytes` stops and cancels an oversized HTTP response while it streams.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Must equal `provider/model`. Agents select a model by this ID. |
| `provider` | string | Provider name shown in the catalog. |
| `model` | string | Model name sent to the endpoint. |
| `baseUrl` | URL | The endpoint, for example `https://api.openai.com/v1`. No credentials, query, or fragment. |
| `apiKey` | string | Sent as the bearer token. |
| `deadlineMs` | integer | Timeout for one model request. |
| `maxInputBytes` | integer | Upper bound for one request body, and the context window reported to Pi. |
| `maxOutputTokens` | integer | Output token limit per request. |
| `maxResponseBytes` | integer | Upper bound for one response. |

Integer limits are positive and at most 1,048,576.

## Tools

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Tool name the model sees and agents enable. |
| `description` | string | Shown to the model and in the agent editor. |
| `effect` | `"read"` or `"write"` |  |
| `connectorId` | string | Tools with the same connector share one origin and one set of credential headers. |
| `version` | string | Part of the tool identity an approval binds to. |
| `inputSchema` | JSON Schema | Arguments are validated against it before dispatch. |
| `outputSchema` | JSON Schema | Results are validated against it. |
| `maxInputBytes` | integer | At most 1 MiB. |
| `maxOutputBytes` | integer | At most 1 MiB. Measured after secrets are removed. |
| `requiresApproval` | boolean | A write always requires approval. |
| `retryMode` | `"idempotent"` or `"at-most-once"` | What happens when a call is interrupted after dispatch. See [interrupted calls](#interrupted-calls). |
| `credentials` | object | Optional. `headers` sent to the connector and extra `secrets` to remove from output. Header values are removed from output too. Bootstrap seals them into the connector account in PostgreSQL with the `account-key` secret, and the Worker never receives them. Once imported, you can remove them from the file. |
| `target` | object | `kind`, `method`, and `url`. See [targets](#targets). |

### Targets

| `kind` | `effect` | Request |
| --- | --- | --- |
| `mcp` | `read` or `write` | MCP `tools/call` over Streamable HTTP after `initialize`, with protocol `2025-11-25` or an older version the server negotiates. `method` is the MCP tool name. `mcp-read` is still accepted as an old name for `mcp`. |
| `http-write` | `write` | `POST` of `{ "arguments", "operationId", "tool" }` as JSON. `tool` is the `method` value. |

Every `write` tool requires `requiresApproval: true`. Every request carries `Idempotency-Key` and `X-Cerebro-Operation-Id` with the call's operation ID. Redirects are refused.

## MCP connectors

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Connector ID. Must differ from every tool's `connectorId`. |
| `url` | URL | The Streamable HTTP endpoint. Production requires public HTTPS. |
| `credentials` | object | Optional. `headers` and `secrets`, sealed into the connector account like tool credentials. |

On every start, bootstrap calls `tools/list` on each connector and replaces that connector's catalog tools. A tool ID is `<connector id>_<MCP tool name>`, with characters outside `[A-Za-z0-9_-]` replaced by `_`, up to 64 characters. A tool the server marks `readOnlyHint: true` is a read. Every other tool is a write that needs approval. Tools the registry cannot load, such as a duplicate ID, are skipped and logged. If the server cannot be reached, the connector keeps its previous tools. Removing a connector from this file removes its tools.

Administrators can also add MCP connectors in the product under Connectors. Those live in PostgreSQL, not in this file, and survive restarts. A connector in this file with the same ID as one added in the product is skipped.

### Interrupted calls

Before a call is dispatched, Pi stores a dispatch marker for it. If the process stops before the outcome is recorded, Pi replays the call. An `idempotent` tool is dispatched again. An `at-most-once` tool is not: the conversation shows the call as an unknown outcome and the run continues.

## Mode rules

| Rule | `local` | `production` |
| --- | --- | --- |
| Model `baseUrl` and tool `url` | HTTP or HTTPS, any host | HTTPS, not `localhost`, `127.0.0.1`, or `[::1]` |
| PostgreSQL | Any | `sslmode=verify-full` |

## Example

```json
{
  "mode": "production",
  "models": [
    {
      "id": "openai/gpt-4.1-mini",
      "provider": "openai",
      "model": "gpt-4.1-mini",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "<API_KEY>",
      "deadlineMs": 90000,
      "maxInputBytes": 131072,
      "maxOutputTokens": 4096,
      "maxResponseBytes": 1048576
    }
  ],
  "tools": [
    {
      "id": "search-tickets",
      "description": "Search support tickets",
      "effect": "read",
      "connectorId": "support-mcp",
      "version": "1",
      "inputSchema": {
        "type": "object",
        "properties": { "query": { "type": "string" } },
        "required": ["query"],
        "additionalProperties": false
      },
      "outputSchema": { "type": "object" },
      "maxInputBytes": 4096,
      "maxOutputBytes": 65536,
      "requiresApproval": false,
      "retryMode": "idempotent",
      "credentials": {
        "headers": { "Authorization": "Bearer <CONNECTOR_TOKEN>" },
        "secrets": []
      },
      "target": {
        "kind": "mcp-read",
        "method": "search_tickets",
        "url": "https://mcp.example.com/rpc"
      }
    }
  ],
  "artifacts": {
    "endpoint": "http://minio-artifacts:9000",
    "bucket": "cerebro-artifacts",
    "accessKeyId": "cerebro",
    "secretAccessKey": "<MINIO_PASSWORD>",
    "region": "us-east-1"
  },
  "gatewaySigningKey": "<RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS>",
  "retrievalMode": "full-text",
  "bootstrapToken": "<DIFFERENT_RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS>"
}
```
