# Final source checks

These commands ran from the managed worktree root after the receipt review fixes.

| Command | Result |
| --- | --- |
| `rtk proxy docker compose -p cerebro-slice-final-20260928 -f experiments/celld-slice/compose.yaml up --build -d --wait` | Exit 0. All four named volumes were created for this project. All services reached readiness. Docker build layers were reused. |
| `rtk proxy docker compose -p cerebro-slice-final-20260928 -f experiments/celld-slice/compose.yaml run --rm check` | Exit 1. 11 pass, 1 fail, 25 not-run. See evidence 06. |
| `rtk proxy docker compose -p cerebro-slice-final-20260928 -f experiments/celld-slice/compose.yaml run --rm --no-deps check npm run check-types` | Exit 0. |
| `rtk proxy pnpm dlx ultracite@7.11.0 fix experiments/celld-slice/src experiments/celld-slice/scripts experiments/celld-slice/fixtures` | Exit 0. |
| `rtk proxy pnpm dlx ultracite@7.11.0 check experiments/celld-slice/src experiments/celld-slice/scripts experiments/celld-slice/fixtures` | Exit 0. All 12 matched files use the correct format. |

The original restart probe used the commands in the README. Evidence 05 records the verification after the host restarted celld, PostgreSQL, and both MinIO services and waited for readiness. It used the existing cookie and database marker written by the preparation command.
