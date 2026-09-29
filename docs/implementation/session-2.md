# Session 2 runtime handoff

## Scope and base

- Branch: `codex/session-runtime`.
- Base commit: `38893f59652cad4b33d228ebda12b07528859625`.
- Scope: session Durable Object, ledger, recovery, outbox, audit projection, and celld checks.

## Runtime boundary

`SessionService` checks the current authorization and entitlement policy before it forwards a command to the session Durable Object. The Durable Object name contains the organization, agent, and conversation IDs. The ledger binds the full address, including session ID, on first admission. Each run stores the agent version selected at admission.

`SessionAgent` extends `agents@0.24.0` and owns the OpenCode model loop. The fixture uses `@opencode-ai/sdk@0.0.0-dev-18697` with one allowed tool. All other model tools are denied. Production model mode fails closed until a real provider and policy gateway are composed in a later session.

The Drizzle Durable SQLite ledger stores run, inbox, operation, invocation, approval, decision, stream, usage, and outbox records. Event and operation claims use one SQLite transaction. The tool intent is durable before the provider call. The provider receipt is durable before the result returns to the model. A repeated completed operation returns the stored result after a current authorization check. Reusing an operation ID with a different kind or digest conflicts. Model call IDs map to logical invocation IDs. A new confirmed model call can have the same arguments and a distinct invocation ID.

The Agent keeps a `reconcile` schedule while runs or outbox events remain. On wake, it checks the current grant before it retries an interrupted idempotent effect with the same operation ID. An interrupted non-idempotent effect enters `unknown-outcome`; it has no automatic retry. Approval and cancellation are stored before the response. Stream cursors come from the ledger sequence, so a client can resume after restart.

The outbox projects audit and usage events to PostgreSQL. The projection uses `event_id` as its conflict key. Failed projection leaves the outbox row for a later wake. The Durable Object remains authoritative for its session. The PostgreSQL schema is in `packages/db/src/schema/audit.ts`; the coordinator owns the shared migration sequence.

The Cerebro SQLite migration owns only `cerebro_session` and `cerebro_operation`. It keeps the exact table names excluded by the guarded Session 0 OpenCode patch. The upgrade check seeds plain-text Session 0 rows, runs the migration, then confirms those rows remain. Ledger queries select only Cerebro record prefixes before Drizzle decodes JSON, so the legacy plain-text row does not break reads.

## Verification

From this worktree root:

```sh
rtk proxy node --test tests/runtime/isolation.test.ts
rtk proxy node --test tests/runtime/recovery.test.ts
rtk proxy ./node_modules/.bin/tsc -p packages/runtime/tsconfig.json --noEmit
rtk proxy ./node_modules/.bin/tsc -p packages/db/tsconfig.json --noEmit --tsBuildInfoFile /tmp/cerebro-session2-db.tsbuildinfo
rtk proxy ./node_modules/.bin/oxlint packages/runtime/src packages/db/src/schema/audit.ts packages/db/src/repositories/audit.ts tests/runtime --deny-warnings
rtk proxy ./node_modules/.bin/oxfmt --check packages/runtime/src packages/db/src/schema/audit.ts packages/db/src/repositories/audit.ts tests/runtime
```

The isolation suite passed 5 of 5 checks on the final fixture code. It proves duplicate delivery, operation conflict, company separation, pinned agent versions, stream cursor replay, cancellation after SIGKILL, outbox retry after a PostgreSQL outage, legacy SQLite rows after migration, and PostgreSQL projection deduplication. The recovery suite passed 2 of 2 checks. It reads the independent provider effect count after SIGKILL and before restart. The idempotent provider received two calls and applied one effect; the run completed after restart. The non-idempotent provider received one call and applied one effect; the run entered `unknown-outcome` without an automatic retry. Approval replay returned the same result. The cursor still retrieved earlier stream items after restart.

Runtime and database TypeScript checks passed. Scoped Oxlint, Oxfmt, and `git diff --check` passed. The fixture bootstrap retries a refused PostgreSQL connection during the database initialization handoff; it does not retry a schema error.

## Integration work

The coordinator must add the runtime package dependencies to the shared lockfile, add the root `test:runtime` script, generate the PostgreSQL audit migration, and compose the runtime binding into the API Worker. This branch does not edit those shared files. The direct `node --test` command above runs the celld suite until the root script exists.

Session 0 still has no real model provider run or successful Worker PostgreSQL connection over publicly trusted TLS. Session 2 uses local fixtures and does not close those gates. The fixture test route reaches the Durable Object directly, so this suite does not prove the API composition or production authorization policy.
