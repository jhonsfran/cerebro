# OpenCode patch verification

Run from the managed worktree root. All commands below completed. The tested celld environment sets `CELLD_V8_HEAP_LIMIT_MB=256`.

## Fresh storage

```sh
rtk proxy docker compose -p cerebro-slice-patched-20260929 -f experiments/celld-slice/compose.yaml up --build -d --wait
rtk proxy docker compose -p cerebro-slice-patched-20260929 -f experiments/celld-slice/compose.yaml run --rm --no-deps check
rtk proxy docker compose -p cerebro-slice-patched-20260929 -f experiments/celld-slice/compose.yaml run --rm --no-deps check npm run check-types
rtk proxy docker compose -p cerebro-slice-patched-20260929 -f experiments/celld-slice/compose.yaml run --rm --no-deps check node scripts/check-patches.mjs
```

Startup exited 0 and created four new named volumes. Build layers were cached. The main check exited 1 with `incomplete`, 19 passing probes, no failing probes, and 22 unrun entries. Evidence 13 records these results. TypeScript and the dependency patch checker exited 0. The final experiment image was `sha256:395bf48d5e75b51321653d2fa391ed40fe20e93164798bc5e596144c7a24b65f`.

## Existing storage and restart

The original `cerebro-slice` project retained its volumes from the unpatched run. It was rebuilt with the patch and the heap setting before these commands.

```sh
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm --no-deps check node scripts/check-migration-restart.mjs prepare
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm --no-deps check node scripts/restart.mjs prepare
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml restart celld postgres minio-runtime minio-artifacts
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml up -d --wait
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm --no-deps check node scripts/check-migration-restart.mjs verify
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm --no-deps check node scripts/restart.mjs verify
```

All exited 0. Evidence 10 records migration preparation. Evidence 11 records all three migration cases passing after restart. Evidence 12 records the preserved auth cookie, committed database row, OpenCode session and messages, and reuse of the completed operation without added messages. These are ordinary restart checks, not fault injection during an external effect.

## Source checks

```sh
rtk proxy node experiments/celld-slice/scripts/check-patches.mjs
rtk proxy pnpm dlx ultracite@7.11.0 check experiments/celld-slice/src experiments/celld-slice/scripts experiments/celld-slice/fixtures
```

Both exited 0. Ultracite checked 15 source files. Patch assertions cover idempotence, exact allowlist, version/source rejection, and unchanged migration code. The independent read-only review found no actionable defects.
