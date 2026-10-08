# Operate the company pilot

The Pi first slice remains under integrated acceptance. Read the [integration record](../architecture/2026-10-07-cerebro-slice-1-integration.md) and [first-slice plan](../architecture/2026-10-05-cerebro-slice-1-plan.md) before enabling it. Deterministic fixture results do not qualify external providers or customer-data cutover.

## Deployment modes

`local` and `production` require a protected `runtime.json` with an explicit real HTTPS model provider and trusted installation setup credentials. They disable fixture routes, grants, sources, and tools. There is no default free model. Configure read-only MCP tools explicitly. Existing agents must select a registered model and start a new conversation after a model change.

`fixture` selects deterministic providers. Bootstrap generates fixture configuration and ingests the fixed pilot source. Use `rtk proxy node tests/slice-1/boot.mjs --project cerebro-s1-NAME` for a fresh disposable fixture. Fixture bootstrap uses its generated configuration and does not read a protected runtime file. Real-provider modes reject a file with a different mode.

## Configure an installation

Use one company per installation. Keep API and web origins stable. Default Compose host ports are API `18765` and web `3001`. `CEREBRO_API_PORT` and `CEREBRO_WEB_PORT` select other loopback ports. Set `CEREBRO_PUBLIC_API_URL` and `CEREBRO_PUBLIC_WEB_URL` before building; the web bundle contains its API origin.

Production requires HTTPS public origins, a reverse proxy, PostgreSQL with `sslmode=verify-full`, and the external secrets directory selected by `CEREBRO_PRODUCTION_SECRETS_DIR`. Preserve that directory with the data. Do not generate new passwords for restored stores.

Bootstrap reads `runtime.json` from the protected secrets directory. Supply it to the local secrets volume or production secrets directory before bootstrap runs. Its artifact password must match artifact MinIO. Local secret initialization does not create real-provider configuration. Configuration changes take effect when bootstrap publishes the Worker again.

The [runtime schema](../../apps/server/src/runtime-configuration.ts) defines the accepted structure. It contains model credentials and request limits, controlled connector targets and credentials, a gateway signing key, artifact storage, full-text retrieval, and trusted setup credentials. Pricing, budget, reservation, response-byte-limit, and per-run request-count fields are rejected. External metering remains unbound; this slice does not enforce a spending balance.

Each model ID is `provider/model`. Model endpoints must implement the OpenAI-compatible completion protocol used by the adapter. The adapter checks outbound input bytes and request duration; the native model configuration supplies the output-token limit. Response-byte and per-run request-count settings are unsupported and rejected; this slice makes no guarantee for those bounds. Pi owns the model and tool loop. Browser attachment and reload do not submit model work. Each MCP registration includes connector ID, input/output schemas, HTTPS target, credentials, byte limits, effect type, approval requirement, and retry mode. Production rejects fixture write connectors.

This example has no tools. Replace all placeholders with private installation values:

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
      "deadlineMs": 30000
    }
  ],
  "tools": [],
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

Keep this file private. Do not commit it. Use a trusted setup token or trusted Better Auth user ID before first setup. Public signup does not grant installation ownership. Owners still need current resource grants. Audit and historical usage exports check grants on every page and return at most 200 records.

## Qualify a configured provider

Run `rtk proxy pnpm test:pi:live` with `CEREBRO_PI_LIVE_CONFIG` set to a private local acceptance file. The [live test](../../tests/live/pi.test.ts) defines its schema. Select a registered real model and real controlled MCP read in an isolated local installation with fixture routes disabled. Keep cookies and provider credentials out of command arguments and reports.

Record the tested SHA, installation identity, selected model/tool, durable output, and controlled read result. Each enabled integration requires live evidence. An unconfigured optional integration is not applicable. Fixture evidence cannot substitute for this check.

## Upgrade and retire old work

1. Record the release, exact image IDs, private configuration, and public origins.
2. Take a consistent backup using the [backup guide](backup.md).
3. Fence old admission, execution, alarms, tools, and replies before snapshot or restore. Use the separate cutover command to snapshot unresolved work, retire old conversations, and quarantine old inbox, projection, and reply queues.
4. Test the release in an isolated restored project after retirement. Restore external databases separately and select a restore-specific database URL before bootstrap or migrations. Keep the retirement fence active before starting any application client.
5. Prove that retirement survives restore, old physical counters stay unchanged, historical exports work, and a fresh Pi conversation succeeds.
6. Complete acceptance and review before a separately authorized traffic change.

Do not convert old checkpoints or delete historical company, audit, usage, or receipt records. Retired conversations require a new conversation. Restore PostgreSQL, both object stores, celld, and credentials from the same snapshot. Rollback requires a full snapshot restore with its images and configuration.

## Rotate secrets

Use a maintenance window. Stop admission, finish active work, and resolve uncertain operations before changing credentials. Update model/MCP credentials in protected configuration, publish the Worker, and verify a permitted operation. Before changing the gateway signing key, stop sessions and let issued capabilities expire.

An auth-secret change invalidates sessions. Database and MinIO password changes require the service and all clients to agree. Preserve backup credentials for restore. Verify sign-in, current permissions, and a controlled read after maintenance.

## Recover an uncertain write

Do not repeat a non-idempotent write with an unknown outcome. Preserve its operation identity and durable receipt. An authorized operator can reconcile it against read-only authoritative provider evidence. Current company, tool, connector, and content grants still apply. Reconciliation must not repeat the write.

## Capacity and measured limits

Use the final first-slice report for current measurements. The [session 7 receipt](../implementation/session-7.md) records historical measurements and does not establish Pi performance. The first-slice budgets require measured admission, browser text, canonical history, alarms, detach cleanup, and ten concurrent conversations. Heap and cell limits are not a capacity guarantee. Use a representative workload before production sizing.
