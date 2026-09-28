# Run the celld compatibility experiment

Run these commands from the worktree root. Docker is the host prerequisite.

```sh
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml up --build -d --wait
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm check
```

The first command builds MinIO from pinned official source because the official image and binary downloads were unavailable during this run. It starts separate runtime and artifact storage services, PostgreSQL, a local model fixture, and celld. Bootstrap installs the SQL schema and deploys the Worker with native `celld deploy`.

The check exits 1 on the recorded Agent/OpenCode schema conflict. It also reports every unproved criterion. Read [the Session 0 receipt](../../docs/implementation/session-0.md) before continuing to Session 1.

Use `http://localhost:18765/health` to inspect Worker readiness. These routes are test fixtures. The deployment uses public, local-only credentials and binds host ingress to loopback. Do not use this configuration for production. The model fixture has no real provider key.

## Check persistence across restart

```sh
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm --no-deps check node scripts/restart.mjs prepare
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml restart celld postgres minio-runtime minio-artifacts
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml up -d --wait
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm --no-deps check node scripts/restart.mjs verify
```

The preparation command writes a local test cookie to the ignored `results` directory with mode 0600. The verification command records only IDs and results. Ordinary restarts preserve all named volumes.

## Inspect results

Read `results/check-*.json` for each run. The committed `evidence` directory contains selected results from this session. A pass for the empty-storage OpenCode control proves initialization only. It does not prove the required Agent composition or model loop.

Run isolated type checks in the built image.

```sh
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm --no-deps check npm run check-types
```

The Docker build applies one version-guarded dependency patch. `@better-auth/utils@0.4.2` uses its own JavaScript password implementation for the `workerd` export. The Node export remains unchanged. No OpenCode migration patch is applied.
