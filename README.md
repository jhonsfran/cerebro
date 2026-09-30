# Cerebro

Cerebro is a self-hosted company assistant. It includes company identity and policy, durable conversations, budget admission, controlled tools, cited memory, web chat, and optional Slack direct messages. Session 7 connects these subsystems in the native celld deployment.

## Start the local stack

Docker is the host prerequisite for the application stack. From a fresh checkout, run:

```sh
docker compose up --build -d --wait
```

Open [the web app](http://localhost:3001). Readiness is available at [the API](http://localhost:18765/ready). The default local mode uses the free `opencode/space-bunny-free` model. Calls use the pinned OpenCode SDK and its public provider key. No paid model fallback is configured. The native live check passed with one settled zero-cost usage receipt. Big Pickle did not pass that check and is excluded from the default catalog. Free model availability can change. Read [OpenCode pricing and privacy](https://opencode.ai/docs/en/zen/) before sending company data.

Local setup requires the generated installation token. Read it from the protected secret volume, then enter it in the setup form:

```sh
docker compose run --rm --no-deps bootstrap node --input-type=module -e 'import {readFile} from "node:fs/promises";process.stdout.write(await readFile("/run/cerebro-secrets/bootstrap-token","utf8"))'
```

Local mode uses real PostgreSQL, MinIO, authorization, and usage records. Model charges are zero `usd-micro` units. No fixture model, source, or tool is enabled. For an existing agent, select an OpenCode model in the editor, remove obsolete fixture tools, and start a new conversation. Existing data stays in its volumes.

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
pnpm test:opencode
pnpm check-types
pnpm check
pnpm build
```

Integration tests explicitly select deterministic fixture mode in isolated Compose projects. `pnpm test:opencode` separately calls the live free provider through the native deployment and verifies a zero-cost usage receipt.

To run the local demonstration with controlled providers instead, use:

```sh
CEREBRO_DEPLOY_MODE=fixture COMPOSE_PROFILES=fixture docker compose up --build -d --wait
```

Use separate Compose project names for local and fixture deployments. A protected `runtime.json` must match its deployment mode.

The backup tests restore all seven stores into fresh volumes and start the recorded source images. Read [the session 7 receipt](docs/implementation/session-7.md) for current deployed acceptance evidence and known check limits.

## Data ownership

Session Durable Objects own execution, conversation state, and replay receipts. PostgreSQL owns company identity, current grants, shared budget, memory metadata, and audit projections. Runtime MinIO preserves celld state. Artifact MinIO holds source and application objects. No transaction spans these stores.

The tool loader has no general outbound network access. It receives the named tool gateway as its capability. Each paid operation needs current authorization and a budget reservation before dispatch. An uncertain model dispatch retains its budget reservation. An uncertain non-idempotent tool stops for reconciliation.

## Production settings

`compose.production.yaml` requires an external directory with `auth-secret`, `postgres-password`, `minio-password`, and the protected `runtime.json` configuration. Set a PostgreSQL URL with `sslmode=verify-full` and HTTPS public origins. Put a TLS reverse proxy in front of the loopback API and web ports. Production rejects fixture providers and policies. Read [the pilot operations guide](docs/operations/pilot.md) for the runtime schema and trusted installation setup.

Read [the backup procedure](docs/operations/backup.md) before maintenance. The automated backup command supports named volumes. Production bind-mounted secrets require the separate procedure in that guide.

A pilot requires live results for every configured model, MCP, identity, budget, telemetry, and Slack integration. Publicly trusted Worker PostgreSQL TLS also requires a live result. The [delivery plan](docs/superpowers/plans/2026-09-28-cerebro-delivery.md) and [session 7 receipt](docs/implementation/session-7.md) identify incomplete qualification checks.
