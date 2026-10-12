# Runtime configuration

`runtime.json` configures the models, tools, and storage that one installation uses. `deploy/bootstrap.mjs` reads it from the secrets directory, validates it with `parseRuntimeConfiguration` in `apps/server/src/config.ts`, and publishes it to the Worker as `RUNTIME_CONFIG_JSON`. The Worker parses it once per isolate. A change takes effect the next time bootstrap runs.

In local mode, `pnpm start` writes this file from the model settings in `.env` (`deploy/local-runtime.mjs`). In production you supply it. The file contains credentials. Do not commit it.

Unknown fields are rejected.

## Top-level fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `mode` | `"local"` or `"production"` | yes | Must match `DEPLOY_MODE`. |
| `models` | array of [models](#models) | yes | At least one. Model IDs are unique. |
| `tools` | array of [tools](#tools) | yes | An empty array enables no tools. |
| `artifacts` | object | yes | `endpoint`, `bucket`, `accessKeyId`, `secretAccessKey`, and `region` of the artifact MinIO or S3 store. |
| `gatewaySigningKey` | string | yes | At least 32 characters. Signs requests from the API to session objects. |
| `retrievalMode` | `"full-text"` | yes | The only supported value. |
| `bootstrapToken` | string | one of two | At least 32 characters. Lets the first user who presents it become the installation owner. |
| `trustedOwnerUserId` | string | one of two | A Better Auth user ID that may become the owner without a token. |

At least one of `bootstrapToken` and `trustedOwnerUserId` is required.

## Models

Every model uses the OpenAI-compatible chat completions API.

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
| `maxRequestsPerRun` | integer | Optional. Defaults to 16. |

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
| `credentials` | object | `headers` sent to the connector and extra `secrets` to remove from output. Header values are removed from output too. |
| `target` | object | `kind`, `method`, and `url`. See [targets](#targets). |

### Targets

| `kind` | `effect` | Request |
| --- | --- | --- |
| `mcp-read` | `read` | MCP `tools/call` over HTTP with protocol `2026-07-28`. `method` is the MCP tool name. |
| `http-write` | `write`, with `requiresApproval: true` | `POST` of `{ "arguments", "operationId", "tool" }` as JSON. `tool` is the `method` value. |

Every request carries `Idempotency-Key` and `X-Cerebro-Operation-Id` with the call's operation ID.

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
