# Operate the company pilot

Local acceptance with the deterministic test provider is complete. External production qualification remains incomplete. Read [the session 7 receipt](../implementation/session-7.md) before enabling a pilot. A result against the test provider does not qualify an external provider.

## Default local models

The default Compose deployment uses `local` mode. It offers `opencode/space-bunny-free` through the native OpenCode SDK. The model uses `https://opencode.ai/zen/v1`, the SDK public key, and zero input/output prices in `usd-micro` units. [OpenCode lists the model as free](https://opencode.ai/docs/en/zen/). The native live check completed and settled one operation with zero charge. Big Pickle returned no authoritative usage receipt in the native check and is excluded from the default catalog. There is no paid fallback. The provider can remove free access. Check the current model terms before using company data.

Local mode creates a persistent `bootstrap-token` alongside the other local secrets. Installation setup requires this token. It uses real policy, PostgreSQL, artifact storage, and durable usage accounting. The application has no test routes or test grants. Configure MCP read tools and approved write connectors explicitly if needed. Existing agents must select a registered model and start a new conversation after a model change.

Local model limits are 65,536 input bytes, 2,048 output tokens, 262,144 response bytes, 90 seconds per request, and eight requests per run. Usage must still have an authoritative token receipt. Local HTTP origins, private model and connector hosts, and local PostgreSQL are permitted; production retains public HTTPS and verified PostgreSQL TLS requirements.

For deterministic testing, add `tests/slice-1/compose.test.yaml` to a local deployment; it supplies a fake model and connectors through an ordinary local `runtime.json`. Use `production` with the production Compose override and explicit runtime configuration for an external deployment. A protected runtime file with a different mode is rejected rather than silently reused.

## Configure an installation

Use one company per installation. Keep the public API and web origins stable. The default host ports are API `18765` and web `3001`; `CEREBRO_API_PORT` and `CEREBRO_WEB_PORT` select other loopback ports. Set `CEREBRO_PUBLIC_API_URL` and `CEREBRO_PUBLIC_WEB_URL` to the matching origins before building. The web bundle contains its public API origin, so an origin change needs a web rebuild.

Production requires HTTPS public origins, a reverse proxy, PostgreSQL with `sslmode=verify-full`, and the external secrets directory selected by `CEREBRO_PRODUCTION_SECRETS_DIR`. Preserve that directory with the data. Never generate fresh passwords for restored data.

`deploy/bootstrap.mjs` reads `runtime.json` from the same protected directory as the other secrets. Every deployment requires that file. A configuration change takes effect when bootstrap publishes the Worker again.

The runtime configuration is secret. It contains model credentials, fixed model prices and request limits, connector targets and credentials, the gateway signing key, artifact storage, and installation setup credentials. Supply real OpenAI-compatible model endpoints, MCP read tools (`mcp-read`), and approved write connectors (`http-write`) in production. A write connector must require approval. Its `retryMode` is `idempotent` when the provider deduplicates by the `Idempotency-Key` header, otherwise `at-most-once`. The current composition supports local PostgreSQL budget authority and full-text memory. Unsupported configured modes fail during configuration parsing.

The exact schema is [runtime-configuration.ts](../../apps/server/src/runtime-configuration.ts). A model ID must be `provider/model`. Prices are nonnegative integer units per token. The maximum reservation is `maxInputBytes * inputPerToken + maxOutputTokens * outputPerToken` and must fit a safe integer. A response needs authoritative OpenAI-compatible token usage before it reaches the SDK. Each run permits at most maxRequestsPerRun requests, with a default of 16. The runtime disables automatic SDK compaction and assigns a session title to avoid auxiliary model calls. A conversation that exceeds the complete outbound request bound fails before dispatch; start a new conversation instead of silently summarizing its history.

This example shows the required production structure. Replace all example values before use. The artifact password must match that MinIO service. Add each MCP tool with its input/output schema, HTTPS target, connector ID, credentials, byte limits, and retry mode; an empty tools array enables no connector.

```json
{
  "mode": "production",
  "models": [
    {
      "id": "company/configured-model",
      "provider": "company",
      "model": "configured-model",
      "baseUrl": "https://model.example.com/v1",
      "apiKey": "REPLACE_MODEL_KEY",
      "maxInputBytes": 16384,
      "maxOutputTokens": 2048,
      "maxRequestsPerRun": 16,
      "maxResponseBytes": 65536,
      "deadlineMs": 30000,
      "pricing": {
        "version": "REPLACE_VERIFIED_PRICE_VERSION",
        "unit": "company-units",
        "inputPerToken": 1,
        "outputPerToken": 1
      }
    }
  ],
  "tools": [],
  "budget": {
    "kind": "local",
    "unit": "company-units",
    "initialUnits": 1000000
  },
  "gatewaySigningKey": "REPLACE_WITH_A_RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS",
  "artifacts": {
    "endpoint": "http://minio-artifacts:9000",
    "bucket": "cerebro-artifacts",
    "accessKeyId": "cerebro",
    "secretAccessKey": "REPLACE_MINIO_PASSWORD",
    "region": "us-east-1"
  },
  "retrievalMode": "full-text",
  "bootstrapToken": "REPLACE_WITH_A_DIFFERENT_RANDOM_SETUP_SECRET_OF_AT_LEAST_32_CHARACTERS"
}
```

Keep this file private. Do not commit it. Local budget initialization runs once per company and unit; publishing a new initialUnits value does not reset spent or held capacity. Do not change the accounting unit while reservations remain held or unsettled.

Configure a trusted setup token or trusted Better Auth user ID before the first production setup. Public signup does not grant installation ownership. The owner still needs explicit current resource grants for tools, sources, and exports. Grant audit export on the company audit resource and usage export on the company budget resource only to the principals that require them. Every export page checks the grant again and returns at most 200 records.

An unconfigured optional integration is not applicable. A configured model, MCP, Entra, Unprice, Jev, or Slack integration needs a recorded live check. Do not enable a configuration that has only passed a fixture test.

## Upgrade

1. Record the deployed Git release, exact image IDs, runtime configuration, and public origins.
2. Complete a consistent backup. Follow [the backup guide](backup.md).
3. Test the new release in a fresh restored project. Restore any external database separately and set a restore-specific `CEREBRO_DATABASE_URL` before bootstrap or migrations run. Preserve recorded public origins through isolated routing. Keep the original project available for recovery.
4. Check migrations and pinned SDK patch hashes before publishing the new Worker.
5. Run readiness and the deployed acceptance checks, including current permissions, accounting replay, and session recovery.
6. Move traffic only after these checks pass.

Bootstrap applies ordered PostgreSQL migrations. Session 7 adds the audit table and permits null embedding metadata for full-text records. There is no automatic down migration. An older memory adapter can fail on records that have no vector. Treat rollback as a full snapshot restore with the recorded images and configuration, rather than a binary downgrade against newer stores. Keep PostgreSQL, both MinIO stores, celld state, and credentials from the same snapshot.

The OpenCode shared SQLite patch is tied to reviewed file hashes. A changed SDK release must pass the native journal-survival test before deployment. Do not remove the patch because a unit test passes.

## Rotate secrets

Use a maintenance window. Stop admission and wait for active work to finish. Check any tool shown as an unknown outcome in the target system before changing provider or gateway credentials.

For model or MCP credentials, update the protected runtime configuration, publish the Worker, and verify one permitted operation. For the gateway signing key, stop active sessions and allow issued capabilities to expire before replacing the key. Check that the restricted loader and gateway use the same new key.

An auth-secret change invalidates existing auth sessions. Verify sign-in after publishing the new binding. A database password change requires the PostgreSQL credential and Worker database URL to agree. A MinIO password change requires both MinIO services and their runtime and artifact clients to agree. Update each pair during the same maintenance window. Keep the old backup credentials protected for restore.

## Handle an unknown tool outcome

Before a tool's effect starts, Pi durably records a dispatch marker for that call. If the process stops after dispatch and before the result is recorded, Pi replays the call on recovery. An `idempotent` tool runs again. An `at-most-once` tool is never dispatched again: the conversation shows the tool as an unknown outcome, and the model is told to ask the user to check the target system. The run then continues.

Cerebro does not query the provider for evidence. Check the target system for the operation ID, which the gateway sends as `Idempotency-Key` and `X-Cerebro-Operation-Id`. A new model call that repeats the action is a new operation and requires its own approval. A dispatched model with no authoritative receipt still keeps its maximum budget reservation.

## Tested deployment size

The final acceptance ran on macOS 26.6.2 with 14 CPUs and 24 GiB host memory. Docker 29.4.0 on aarch64 had 14 CPUs and 12,599,529,472 bytes of VM memory. Existing development containers remained active. The local fixture used a 16,384-byte request bound, 2,048 output tokens, a 65,536-byte response bound, and a 30-second deadline.

Two sessions competed for capacity equal to one maximum model request. One provider request remained held while the other session failed admission. During this contention, celld used 547.7 MiB and PostgreSQL used 34.31 MiB. The database had three connections, including the measurement probe. All six fixture stack containers totaled about 1.24 GiB in that sample. This is not a peak or capacity result.

The first admission receipt took 105 ms. The first visible buffered answer and completion took 7,287 ms. MCP provider duration was 3 ms. Approval recovery after SIGKILL took 15,028 ms. The seven-volume backup, fresh restore, and application checks took 97,216 ms. Output polling adds a 400 ms interval plus request time. Resource sampling added 2,633 ms within the 4,684 ms contention duration. These values describe application acceptance with local fixtures, not external provider performance.

The default celld settings are 256 MiB V8 heap, 16 resident cells, and 10 seconds idle eviction. These are configured limits. See [the receipt](../implementation/session-7.md) for the focused comparison and per-container samples. A production sizing decision needs a representative provider, workload, and load test.
