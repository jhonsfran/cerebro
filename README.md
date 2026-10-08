# Cerebro

Cerebro is a self-hosted company assistant with company permissions, durable conversations, controlled tools, cited memory, web chat, and optional Slack direct messages. The first slice uses Pi Durable on celld, Effect application services, and TanStack AI for browser observation. Integrated acceptance remains in progress; see the [integration record](docs/architecture/2026-10-07-cerebro-slice-1-integration.md).

## Start a disposable local fixture

Docker is required. Install frozen development dependencies with pnpm 11.9.0, then start a fresh isolated project:

```sh
rtk proxy pnpm install --frozen-lockfile
rtk proxy node tests/slice-1/boot.mjs --project cerebro-s1-demo
```

The fixture web app is at [localhost:4001](http://localhost:4001); API readiness is at [localhost:28765/ready](http://localhost:28765/ready). Boot evidence records the source SHA, project, ports, and immutable images under `artifacts/slice-1/`. The deterministic model and tool providers count effects. This mode does not establish live-provider acceptance.

Remove only this disposable project's containers and volumes with:

```sh
rtk proxy node tests/slice-1/boot.mjs --project cerebro-s1-demo --down
```

Use a different project name and free ports for another fixture. Boot rejects existing projects and volumes.

## Configure real providers

The default Compose mode is `local`. It requires a protected `runtime.json` with an explicitly configured HTTPS model provider. There is no built-in free model or billing authority. Local and production modes disable fixture routes and require trusted installation setup credentials. Read the [pilot operations guide](docs/operations/pilot.md) before starting a real-provider installation.

Compose preserves seven named volumes for PostgreSQL, both MinIO stores, celld, and credentials. `docker compose down` preserves them; `docker compose down --volumes` deletes them. Bootstrap creates buckets, applies migrations, and publishes the Worker through native celld deployment. Preserve old stores and use the separate retirement procedure before enabling the new engine on existing conversations.

## Run checks

```sh
rtk proxy pnpm test:contracts
rtk proxy pnpm test:identity
rtk proxy pnpm test:policy
rtk proxy pnpm test:memory
rtk proxy pnpm test:channels
rtk proxy pnpm test:pi-durable:qualification
rtk proxy pnpm test:runtime
rtk proxy pnpm test:policy:runtime
rtk proxy pnpm test:channels:native
rtk proxy pnpm test:boot
rtk proxy pnpm test:chat
rtk proxy pnpm test:integration
rtk proxy pnpm check-types
rtk proxy pnpm check
rtk proxy pnpm build
```

The qualification report distinguishes passed, failed, superseded, and unrun cases. Its exit status alone is not an acceptance verdict. Deterministic tests use isolated local stacks. The separate `rtk proxy pnpm test:pi:live` command requires `CEREBRO_PI_LIVE_CONFIG`, a path to a private local acceptance configuration. It must exercise a real model and one real controlled MCP read.

## Data ownership and operations

PostgreSQL owns company identity, current grants, memory metadata, audit projections, and preserved historical usage. Cerebro session SQLite owns product history and tool receipts. Pi owns private engine checkpoints, its inbox, and execution recovery. Runtime MinIO preserves celld state; artifact MinIO holds source and application objects. No transaction spans these stores.

Commands, history, and observation require current company and content access. The tool loader receives a restricted gateway capability. An uncertain non-idempotent write stops for authorized reconciliation. External metering remains unbound in this slice.

Production requires HTTPS public origins, verified PostgreSQL TLS, a reverse proxy, and a protected secrets directory. The current [runtime schema](apps/server/src/runtime-configuration.ts) rejects obsolete pricing and local-budget configuration. Read the [backup procedure](docs/operations/backup.md) before maintenance.

The [first-slice plan](docs/architecture/2026-10-05-cerebro-slice-1-plan.md) defines the required acceptance and review gates. Historical session receipts describe earlier implementations; they do not qualify this release. Deployment and customer-data cutover require separate authorization.
