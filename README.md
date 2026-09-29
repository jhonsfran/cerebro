# Cerebro

Cerebro is a self-hosted company assistant. This repository currently contains the session 1 foundation: domain contracts, a Hono and Better Auth API Worker, PostgreSQL, a Durable Object storage fixture, MinIO, and a TanStack Start web container. The agent runtime and product flows are later sessions.

## Start the local fixture

Docker is the only host prerequisite for the application stack. From a fresh checkout, run:

```sh
docker compose up --build -d --wait
```

Open the web app at [http://localhost:3001](http://localhost:3001). The API readiness endpoint is [http://localhost:18765/ready](http://localhost:18765/ready). Compose generates local secrets once in a named volume. PostgreSQL, both MinIO services, and celld also use named volumes.

Stop the containers with `docker compose down`. A later `docker compose up -d --wait` preserves users, sessions, artifacts, and local secrets. `docker compose down --volumes` deletes that local state.

The one-shot `bootstrap` service creates the MinIO buckets, applies PostgreSQL migrations, and publishes the API Worker with native `celld deploy`. Run `pnpm deploy` after changing the Worker in an existing local stack.

## Run checks

For repository development, install pnpm 11.9.0 and run:

```sh
pnpm install --frozen-lockfile
pnpm check-types
pnpm build
pnpm test:contracts
pnpm test:boot
```

`test:boot` starts an isolated Compose project. It creates an auth user, a Durable Object session, and a MinIO artifact. It stops and starts the stack, then reads all three records. The test deletes only its own volumes after a pass.

The repository-wide `pnpm check` still reports formatting and lint issues in files outside session 1. The session 1 files have a separate scoped lint check recorded in [the session 1 handoff](docs/implementation/session-1.md).

## Data ownership

PostgreSQL owns Better Auth data and the shared organization record. `packages/db/src/migrations` is the PostgreSQL migration sequence. A PostgreSQL repository operation uses one request-scoped connection and one transaction when it changes related rows.

Session Durable Objects own conversation state. `packages/db/src/durable.ts` supplies the separate Drizzle SQLite adapter. Session 2 owns the Durable Object ledger schema and migrations. The session 1 fixture stores only a test session.

MinIO runtime storage holds celld state. A separate MinIO service holds application artifacts. No transaction spans PostgreSQL, a Durable Object, and MinIO.

## Production settings

`compose.production.yaml` selects production mode. It requires an external directory with `auth-secret`, `postgres-password`, and `minio-password` files. Each secret must contain at least 32 characters. Set `CEREBRO_DATABASE_URL` to a PostgreSQL URL with `sslmode=verify-full`. Set both public URLs to HTTPS origins. Production mode rejects fixture adapters.

Use a TLS reverse proxy in front of the loopback API and web ports. The session 0 receipt still has two open checks: a real model provider and Worker PostgreSQL over publicly trusted TLS. The production configuration is not a qualified pilot deployment until those checks and later session tests pass.

## Packages

- `apps/server` contains the Hono API Worker.
- `apps/web` contains the TanStack Start web app.
- `packages/contracts` defines domain types, ports, and deterministic fixtures.
- `packages/db` defines PostgreSQL schemas, migrations, and the separate Durable SQLite adapter.
- `packages/auth` configures Better Auth.
- `packages/api` contains oRPC routes.

See [the delivery plan](docs/superpowers/plans/2026-09-28-cerebro-delivery.md) for later sessions.
