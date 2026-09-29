# Session 1 foundation handoff

## Scope and base

- Branch: `codex/cerebro-foundation`.
- Base commit: `4168b38950992de3b602840b5d32c30b6bfd3d4a` on `main`.
- Contract commits: `6ed1448df2b5eae20cd565b2cd522c676a83da05`, `abcf2efc0eae9c9f605fcfdf059a4ceebce08222`, `c2cc724a9af55f44095dd745a7d91ba95085e88d`, `6f802d426568986a8ea1f755fe4fcd90ee143609`, and `86f31896ebcbf5f3dc8eb9d670d58562370fccff`.
- Foundation implementation commit: `2af5f98dc4e81e85a745113088a4b64c3673a0db`.
- Assigned scope: shared contracts, PostgreSQL schema and migration, API Worker composition, native celld deployment, Compose services, fixture boot checks, root scripts, and this handoff.

Session 0 reports 41 passing checks and two unrun checks. The real model provider and Worker PostgreSQL over publicly trusted TLS remain unverified. Session 1 local fixture results do not close Gate 0.

## Implemented boundary

The contracts define principal and delegation context, event identity and replay, session commands, tool invocations and approvals, policy outcomes, memory queries, cancellation, deadlines, and idempotent port results. Ports cover `SessionService`, `AuthorizationPolicy`, `AgentRepository`, `ToolExecutor`, `MemoryStore`, `ArtifactStore`, `EntitlementPolicy`, `BudgetAuthority`, and `DecisionMaker`. The fixture constructor implements all nine ports with deterministic results. Fixture construction rejects production mode.

The API remains a Hono Worker with Better Auth. Its PostgreSQL operations use a request-scoped Postgres.js connection. The Worker opens and closes that connection within one request operation. A repository that changes related PostgreSQL rows must use one PostgreSQL transaction. No transaction spans PostgreSQL, a Durable Object, and MinIO. The API owns the transaction boundary when it composes repositories.

`packages/db/src/schema/auth.ts` and `packages/db/src/schema/core.ts` are the current PostgreSQL schema modules. `packages/db/src/migrations` is the PostgreSQL migration sequence. Session owners add separate schema modules. The coordinator generates migrations in integration order. `packages/db/src/durable.ts` creates the Drizzle Durable SQLite adapter. Session 2 owns the session ledger schema and its separate SQLite migrations. The session 1 Durable Object contains only a persistence fixture.

The local Compose stack runs PostgreSQL, separate MinIO services for celld state and artifacts, a one-shot bootstrap service, celld, and the TanStack Start web container. Bootstrap creates buckets, applies PostgreSQL migrations, and publishes the API Worker with native `celld deploy`. Local secrets are generated once in a named volume. Secret initialization copies only the required credentials into service-specific volumes. The web container has no secret mount. Ordinary `docker compose down` and `up` keep the named volumes. Compose uses project-specific image tags, so separate worktrees do not replace each other's images.

The production Compose override requires an external secret directory, HTTPS public URLs, and a PostgreSQL URL with `sslmode=verify-full`. In pinned Postgres.js 3.4.9, `sslmode=require` disables certificate verification. The Worker rejects fixture adapters in production mode. This configuration is not a production qualification. Session 0 has no successful publicly trusted TLS Worker check, and later real adapters and integration tests are still required.

Alchemy and D1 application paths were removed. The root `deploy` script rebuilds the bootstrap image, then calls the native celld bootstrap. The Dockerfile copies only the source needed to build and excludes local credential files. The Better Auth `workerd` password export patch is guarded by the exact utility package version and expected export map. It selects the package's JavaScript password implementation, as the session 0 runtime test required.

## Reproduce

The local stack needs Docker on the host. From this worktree root:

```sh
rtk proxy docker compose -p cerebro-s1 up --build -d --wait
rtk proxy docker compose -p cerebro-s1 ps
COMPOSE_PROJECT_NAME=cerebro-s1 rtk proxy pnpm deploy
rtk proxy docker compose -p cerebro-s1 down
rtk proxy docker compose -p cerebro-s1 up -d --wait
```

The web app is at `http://localhost:3001/`. API readiness is at `http://localhost:18765/ready`. For an isolated fresh boot and restart check, run `rtk proxy pnpm test:boot`. It selects distinct ports and a distinct Compose project. It removes only its own volumes after a pass.

To validate production configuration syntax without starting it, set `CEREBRO_PRODUCTION_SECRETS_DIR`, `CEREBRO_DATABASE_URL`, `CEREBRO_PUBLIC_API_URL`, and `CEREBRO_PUBLIC_WEB_URL`, then run:

```sh
rtk proxy docker compose -f compose.yaml -f compose.production.yaml config --quiet
```

## Verification

| Check | Result | Limit |
| --- | --- | --- |
| `rtk proxy pnpm test:contracts` | 35 passed | Deterministic fixtures and port behavior only. |
| `rtk proxy pnpm check-types` | 7 workspace tasks passed | Type check does not prove runtime behavior. |
| `rtk proxy pnpm build` | 5 workspace tasks passed | Web build emits a chunk-size warning. |
| `rtk proxy pnpm --filter @cerebro/db db:generate` | No schema changes | PostgreSQL migration matches current schema. |
| Scoped `oxfmt --check`, `oxlint`, and `git diff --check` | Passed | Scope is session 1 files. |
| `rtk proxy pnpm test:boot` | Fresh boot and restart passed | Real celld API Worker, PostgreSQL auth user, Durable Object session, MinIO artifact, and cross-user session denial. The production TLS guard has a separate test. |
| `COMPOSE_PROJECT_NAME=cerebro-s1 rtk proxy pnpm deploy` | Passed | Rebuilt bootstrap image and published a new Worker version. API readiness returned 200 afterward. |
| Production `docker compose config --quiet` | Passed with example values | Validates configuration and per-service secret mounts. It does not start production services. |
| `rtk proxy pnpm check` | Failed | Existing format and lint errors in files outside session 1, including `.agents/skills`, experiment evidence, and unchanged web UI files. |

The pre-commit hook now runs Ultracite on staged files only. This keeps repository-wide baseline errors from changing files outside the commit.

The boot test creates an auth user, reads its session, creates a Durable Object session, denies a second user access to it, and writes a MinIO artifact. It stops and starts the stack with the same volumes, then reads the auth session, Durable Object session, and artifact again. The test does not exercise the model loop or production adapters.

The current TanStack Start SSR bundle was deployed to a separate celld probe Worker. The Worker failed to load with `Error: console.createTask() is not implemented` from React's development bundle. The web app therefore runs in a Node container. This is a runtime probe, not an assumption from build output. Reproduce it with:

```sh
rtk proxy docker compose -p cerebro-s1 run --rm --no-deps -v "$PWD/deploy/probe-ssr.mjs:/app/deploy/probe-ssr.mjs:ro" bootstrap node deploy/probe-ssr.mjs
```

## Version record and open work

The tested stack uses Docker Compose 5.1.2, celld 0.6.0, PostgreSQL 17.9, Node 24.14.0 in the application image, Better Auth 1.7.6, Drizzle ORM 0.45.3, Postgres.js 3.4.9, and pnpm 11.9.0. Drizzle Kit 0.31.10 generates the migration. Drizzle Kit 1.0 RC failed because its `./_relations` package export was absent at this Drizzle ORM version.

Gate 0 remains incomplete until a real model provider run and a successful Worker PostgreSQL connection over publicly trusted TLS are recorded. Session 2 must replace the Durable Object persistence fixture with the ledger and its migrations. Sessions 3 through 6 must implement their real adapters. Session 7 must verify them together before a production pilot claim.
