# Run the celld compatibility experiment

This is the historical Session 0 experiment record. The experiment sources were removed after Session 7. The commands below require the original sources from Git commit `ebaed39`. Current runtime test assets are in `tests/runtime`.

Run these commands from the worktree root. Docker is the host prerequisite.

```sh
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml up --build -d --wait
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm check
```

The first command builds MinIO from pinned official source because the official image and binary downloads were unavailable during this run. It starts separate runtime and artifact storage services, PostgreSQL, a local model fixture, and celld. Bootstrap installs the SQL schema and deploys the Worker with native `celld deploy`.

The main check runs the API, schema, deterministic OpenCode loop, approved effect broker, denied tool paths, and HTTP reconnect probes. It exits 1 while Gate 0 has unproved criteria. Host-controlled crashes, browser checks, and provider checks have separate results. An `incomplete` gate does not permit Session 1. Read [the Session 0 receipt](../../session-0.md) before continuing to Session 1.

Use `http://localhost:18765/health` to inspect Worker readiness. These routes are test fixtures. The deployment uses public, local-only credentials and binds host ingress to loopback. Do not use this configuration for production. The model fixture has no real provider key.

## Check persistence across restart

```sh
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm --no-deps check node scripts/restart.mjs prepare
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml stop celld postgres minio-runtime minio-artifacts
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml up -d --no-deps --wait postgres minio-runtime minio-artifacts
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml up -d --no-deps --wait celld
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm --no-deps check node scripts/restart.mjs verify
```

The preparation command writes a local test cookie to the ignored `results` directory with mode 0600. The verification command records only IDs and results. It checks the existing OpenCode session and messages and retries a completed operation ID without adding messages. Start storage and wait for readiness before starting celld. celld exits if its bucket is unavailable at startup. Ordinary restarts preserve all named volumes. This does not prove crash recovery during an external effect.

## Inspect results

Read `results/check-*.json` for each main run. The main command labels host and browser criteria as not run in that command. The selected snapshot summary in `evidence/28-session-zero-status.json` combines those separate reports with explicit artifact references. Regenerate it with `rtk proxy node experiments/celld-slice/scripts/summarize-evidence.mjs`. That command summarizes saved evidence; it does not run the probes. The committed `evidence` directory contains selected results from this session. A pass for the empty-storage OpenCode control proves initialization only. It does not prove the required Agent composition or model loop.

Run isolated type checks in the built image.

```sh
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm --no-deps check npm run check-types
```

The Docker build applies two guarded dependency patches. `@better-auth/utils@0.4.2` uses its own JavaScript password implementation for the `workerd` export. The Node export remains unchanged. The OpenCode 0.0.0-dev-18697 patch excludes twelve exact Agent and Cerebro table names from its initial table census. Package version and full source hashes reject unreviewed versions or changes. Existing migration branches are unchanged. Run `rtk proxy node experiments/celld-slice/scripts/check-patches.mjs` after installing the pinned experiment dependencies to check both patches in a temporary package tree.

The local celld process uses `CELLD_V8_HEAP_LIMIT_MB=256`. The default 128 MiB limit rejected SQL result materialization after OpenCode loaded. The deterministic model declares a 32,768-token context so OpenCode’s default 20,000-token compaction reserve does not force immediate compaction.

## Check OpenCode migration compatibility

Run after startup, with no other check still using celld. Preparation creates separate disposable objects with current migration records, one real pending upstream migration, and legacy name records over the current schema.

```sh
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm --no-deps check node scripts/check-migration-restart.mjs prepare
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml restart celld
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml up -d --wait
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm --no-deps check node scripts/check-migration-restart.mjs verify
```

This checks unchanged data, preserved migration completion times, the pending nullable-workspace migration, and legacy marker import. Legacy marker import does not prove every historical schema upgrade. Results are written to `results/migration-restart-evidence.json`.

## Check approval, reconnect, and crash recovery

The main check invokes `check-broker.mjs`, `check-tool-denial.mjs`, and `check-reconnect.mjs`. Their evidence files contain the individual assertions. The reconnect probe uses a bounded HTTP long poll. It does not test SSE event cursors.

Run process failures from the host, one command at a time. Set `COMPOSE_PROJECT_NAME` if the project is not `cerebro-slice`.

```sh
rtk proxy node experiments/celld-slice/scripts/check-recovery-host.mjs
rtk proxy node experiments/celld-slice/scripts/check-outages-host.mjs
rtk proxy node experiments/celld-slice/scripts/check-baseline-host.mjs
```

The crash runner verifies exit 137 after each SIGKILL. It observes the independent fixture before sending a new Session request. The observation deadline is 300 seconds. celld's default waker interval is 60 seconds and its waker lease is 180 seconds. A restarted node can take several minutes to recover a pending alarm.

The provider saves each effect before its held reply. An idempotent retry uses the same invocation ID. A non-idempotent interrupted dispatch becomes `unknown-outcome` and is not retried. These assertions cover the controlled provider and one logical effect per fixture DO.

The baseline records request latency, PostgreSQL connection samples, and Docker container memory samples. Memory values are sampled peaks for the whole container. The fixture loop uses Durable SQLite and does not require PostgreSQL. This is not a production capacity test.

Open `http://localhost:18765/browser` and click **Run local auth check**. The page calls `http://localhost:18768` with credentials. A successful result records signup, sign-in, session read, sign-out, and a final 401. It does not display cookies.

## Check the private CA limit

Generate disposable fixture certificates inside the ignored experiment results directory. Start the optional TLS database on the internal Compose network.

```sh
rtk proxy node experiments/celld-slice/scripts/generate-tls-fixture.mjs
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml -f experiments/celld-slice/compose.tls.yaml --profile tls up -d --wait postgres-tls
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml -f experiments/celld-slice/compose.tls.yaml --profile tls run --rm --no-deps check node scripts/check-tls.mjs
```

The Node control verifies the private CA and hostname and queries `pg_stat_ssl`. The Worker probes the same fixed database. This distinguishes a private CA trust failure from a broken fixture. It does not establish successful Worker PostgreSQL with a publicly trusted certificate.

## Repeat on fresh storage

Stop the existing project with `down`, without `-v`. Start a distinct project name with the first two commands in this guide. Use that name for every later Compose command and set `COMPOSE_PROJECT_NAME` for the host scripts. This creates new volumes while preserving the earlier results. Cached image layers can be reused.

The real model check requires a separately configured non-production provider. A missing provider configuration keeps Gate 0 incomplete. Do not infer a pass from deterministic fixture results.

## Runtime lifetime and capacity settings

The local experiment uses a 256 MiB isolate heap limit, 10-second idle eviction, and a maximum of 16 resident cells. Completed SDK clients are closed. Pending approval or effect work retains its runtime until a terminal state. These settings are required for the recorded repeated-load checks; they do not establish production capacity.

Inspect the local runtime counters with this host command. Set `COMPOSE_PROJECT_NAME` when using a different project name.

```sh
rtk proxy node experiments/celld-slice/scripts/census-host.mjs after-load
rtk proxy node experiments/celld-slice/scripts/check-lifecycle-host.mjs
```

The census includes retiring isolates. Its heap value is aggregate committed physical V8 memory, not used heap or per-session memory. The internal endpoint is read inside the container. It is not published on a host port.

The recovery probes use 60-second timeout signals. Their timers can keep completed requests in the census until expiry. Observe for up to 120 seconds after the workload before judging resource release. Preserve the same process and deployment version during that observation.

The lifecycle runner performs two main-check and baseline rounds. It saves each round under `results/lifecycle-round-1` and `results/lifecycle-round-2` and writes `results/lifecycle-evidence.json`. It fails if the process or deployment changes, a workload fails, or the cell request counters do not drain within the observation window.
