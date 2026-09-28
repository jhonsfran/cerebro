# Run the celld compatibility experiment

Run these commands from the worktree root. Docker is the host prerequisite.

```sh
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml up --build -d --wait
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm check
```

The first command builds MinIO from pinned official source because the official image and binary downloads were unavailable during this run. It starts separate runtime and artifact storage services, PostgreSQL, a local model fixture, and celld. Bootstrap installs the SQL schema and deploys the Worker with native `celld deploy`.

The patched Agent/OpenCode composition and deterministic tool loop pass. The check still exits 1 because Gate 0 has unproved criteria. An `incomplete` gate does not permit Session 1. Read [the Session 0 receipt](../../docs/implementation/session-0.md) before continuing to Session 1.

Use `http://localhost:18765/health` to inspect Worker readiness. These routes are test fixtures. The deployment uses public, local-only credentials and binds host ingress to loopback. Do not use this configuration for production. The model fixture has no real provider key.

## Check persistence across restart

```sh
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm --no-deps check node scripts/restart.mjs prepare
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml restart celld postgres minio-runtime minio-artifacts
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml up -d --wait
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm --no-deps check node scripts/restart.mjs verify
```

The preparation command writes a local test cookie to the ignored `results` directory with mode 0600. The verification command records only IDs and results. It checks the existing OpenCode session and messages and retries a completed operation ID without adding messages. Ordinary restarts preserve all named volumes. This does not prove crash recovery during an external effect.

## Inspect results

Read `results/check-*.json` for each run. The committed `evidence` directory contains selected results from this session. A pass for the empty-storage OpenCode control proves initialization only. It does not prove the required Agent composition or model loop.

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
