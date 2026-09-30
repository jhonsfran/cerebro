# Cerebro

Cerebro is a self-hosted company assistant. It includes company identity and policy, durable conversations, budget admission, controlled tools, cited memory, web chat, and optional Slack direct messages. Session 7 connects these subsystems in the native celld deployment.

## Start the local stack

Docker is the host prerequisite for the application stack. From a fresh checkout, run:

```sh
docker compose up --build -d --wait
```

Open [the web app](http://localhost:3001). Readiness is available at [the API](http://localhost:18765/ready). The default local mode uses deterministic external-provider fixtures. It does not qualify a live provider.

Compose generates local secrets once. PostgreSQL, both MinIO services, celld, and credentials use seven named volumes. `docker compose down` preserves that state. `docker compose down --volumes` deletes it.

The bootstrap service creates MinIO buckets, applies PostgreSQL migrations, and publishes the API Worker with native `celld deploy`. Run `pnpm deploy` after changing the Worker in an existing local stack.

## Run checks

Install pnpm 11.9.0 for repository development.

```sh
pnpm install --frozen-lockfile
pnpm test:contracts
pnpm test:runtime
pnpm test:identity
pnpm test:policy
pnpm test:memory
pnpm test:channels
pnpm test:integration
pnpm check-types
pnpm check
pnpm build
```

Integration tests use isolated Compose projects. The backup tests restore all seven stores into fresh volumes and start the recorded source images. Read [the session 7 receipt](docs/implementation/session-7.md) for current deployed acceptance evidence and known check limits.

## Data ownership

Session Durable Objects own execution, conversation state, and replay receipts. PostgreSQL owns company identity, current grants, shared budget, memory metadata, and audit projections. Runtime MinIO preserves celld state. Artifact MinIO holds source and application objects. No transaction spans these stores.

The tool loader has no general outbound network access. It receives the named tool gateway as its capability. Each paid operation needs current authorization and a budget reservation before dispatch. An uncertain model dispatch retains its budget reservation. An uncertain non-idempotent tool stops for reconciliation.

## Production settings

`compose.production.yaml` requires an external directory with `auth-secret`, `postgres-password`, `minio-password`, and the protected `runtime.json` configuration. Set a PostgreSQL URL with `sslmode=verify-full` and HTTPS public origins. Put a TLS reverse proxy in front of the loopback API and web ports. Production rejects fixture providers and policies. Read [the pilot operations guide](docs/operations/pilot.md) for the runtime schema and trusted installation setup.

Read [the backup procedure](docs/operations/backup.md) before maintenance. The automated backup command supports named volumes. Production bind-mounted secrets require the separate procedure in that guide.

A pilot requires live results for every configured model, MCP, identity, budget, telemetry, and Slack integration. Publicly trusted Worker PostgreSQL TLS also requires a live result. The [delivery plan](docs/superpowers/plans/2026-09-28-cerebro-delivery.md) and [session 7 receipt](docs/implementation/session-7.md) identify incomplete qualification checks.
