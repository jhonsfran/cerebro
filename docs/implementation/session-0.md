# Session 0 runtime receipt

The pinned Agent/OpenCode schema conflict is fixed by a guarded dependency patch. The deterministic model/tool loop and ordinary session restart checks pass. Gate 0 remains incomplete because the broker, approval, crash-recovery, and other listed checks are still unproved. Session 1 remains blocked. Product files are unchanged.

## Initial blocker and applied fix

`agents@0.24.0` creates `cf_agents_*` and `cf_agent_tool_runs` tables in its base constructor. `@opencode-ai/sdk@0.0.0-dev-18697` initializes its database afterward. Its unpatched migrator rejects nonempty databases without an OpenCode `session` or `session_v2` table.

A fresh Agent object returned HTTP 500 with `Database is not empty and has no session table`. The same OpenCode package initialized successfully in a separate Durable Object containing only runtime tables. No Cerebro table existed before the failing call. Moving Cerebro ledger creation after OpenCode did not resolve the conflict.

[The fresh-project result](../../experiments/celld-slice/evidence/06-fresh-project.json) records the actual table names and both responses. The control proves initialization only. It does not prove the model loop, recovery, or the required composition.

The relevant pinned package code is `@opencode-ai/core/dist/chunks/file-mutation-vp77fm2w.js`. Its migration census includes every table except SQLite and underscore-prefixed runtime tables. `agents/dist/src-BNU3ZiJM.js` calls `_ensureSchema()` from the base constructor. `@opencode-ai/server/dist/workerd.js` supplies the same `DurableObjectStorage` to OpenCode. This release exposes no separate database or schema namespace option.

The applied patch excludes twelve exact table names from the initial census. Ten are the Agent tables observed in evidence 06. Two are `cerebro_session` and `cerebro_operation`. It accepts only the pinned package version and exact original or patched source hash. It changes only that SQL query. Existing OpenCode migration branches remain byte-identical.

Unknown tables, prefix lookalikes, and a partial OpenCode schema without a session table remain rejected. Real Agent and Cerebro tables now coexist with OpenCode. A pre-existing Cerebro operation row is preserved. [Final fresh-project evidence](../../experiments/celld-slice/evidence/13-patched-fresh-project.json) records 19 passing probes, no failing probes, and 22 unrun entries.

[Migration restart evidence](../../experiments/celld-slice/evidence/11-migration-restart.json) covers current migration records, execution of the last real upstream migration from its genuine prefix, and legacy name-marker import. Data survives. Existing marker completion times remain unchanged for current and pending cases. Legacy marker import uses the current schema; it does not prove every historical schema upgrade.

## Tested environment

- Branch `codex/celld-feasibility`.
- Plan and base commit `5d886125646a69b34ed74a74f4d84bea7572d8b8`.
- Initial failing experiment commit `24c4e2032d86d97b2141c38f104815064eda5f25`.
- Patched implementation commit `c233b99afab54083c96e056280d03cc1820b2c4f`.
- Host macOS 26.6.2 on ARM64. Docker Engine 29.4.0 runs Linux ARM64 in OrbStack.
- The Docker VM exposes 14 CPUs and 12,599,529,472 bytes of memory.
- celld 0.6.0, source commit `bad4649d01f0db84cdc9093527e72e64ca7a14bf`.
- MinIO source tag `RELEASE.2025-09-07T16-13-09Z`, commit `07c3a429bfed433e49018cb0f78a52145d4bedeb`, built with Go 1.24.7.
- PostgreSQL 17.9 and Node 24.14.0.
- Patched runs set `CELLD_V8_HEAP_LIMIT_MB=256`.
- Agents 0.24.0, OpenCode SDK 0.0.0-dev-18697, Hono 4.13.10, Better Auth 1.7.6, Drizzle 0.45.3, and Postgres.js 3.4.9.

[The Dockerfile](../../experiments/celld-slice/Dockerfile) pins image digests and the MinIO archive checksum. [The npm lockfile](../../experiments/celld-slice/package-lock.json) pins transitive dependencies. No root dependency file changed.

The official MinIO image pulls failed from Docker Hub and Quay. The official binary URL returned HTTP 410. Building the official pinned source allowed the requested MinIO topology to run. The experiment provisions separate MinIO services and volumes for runtime storage and application artifacts. Only runtime storage was exercised. The Worker has no artifact binding or object read/write probe yet.

## Additional runtime settings

At celld's default 128 MiB per-isolate heap limit, loading OpenCode caused SQL result materialization to fail. [The exact error](../../experiments/celld-slice/evidence/08-heap-limit.txt) identifies that limit. The same probes pass with the supported 256 MiB setting. This is a tested configuration, not a measured minimum or a capacity benchmark. It does not prove compatibility with Cloudflare's default memory limit.

The deterministic fixture now declares a 32,768-token context. Its original 8,192-token context was smaller than OpenCode's default 20,000-token compaction reserve. The loop then attempted compaction after the first tool call and received no summary from the simple fixture. Changing the fixture limit allowed the intended one-tool loop to finish. Compaction behavior remains unqualified.

## Observed results

| Check | Result | Evidence or limit |
| --- | --- | --- |
| Native celld deployment and Hono ingress | Pass | `celld deploy` built and published the Worker to local MinIO. `/health` returned 200. |
| Worker PostgreSQL transport | Pass | Postgres.js selected its `workerd` export and used `cloudflare:sockets`. No database proxy was added. |
| Drizzle commit and rollback | Pass | The check container queried PostgreSQL independently. Only the committed marker existed. |
| Repeated requests after idle | Pass | Three requests separated by 1.5 seconds returned the committed row. Each request owns and closes its connection. |
| Default Better Auth signup | Fail | celld does not implement the native `scrypt` used by the default Workers export. [Unpatched result](../../experiments/celld-slice/evidence/01-unpatched-api.json). |
| Better Auth with the recorded patch | Pass | Signup, sign-in, session read, sign-out, stale-cookie denial, and invalid credentials. [Patched result](../../experiments/celld-slice/evidence/02-patched-api.json). |
| Origin rejection and CORS response | Pass | Untrusted signup returned 403. The preflight returned 204, allowed POST and Content-Type, and returned the exact origin and credentials header. This is HTTP protocol coverage, not a browser run. |
| Database and auth persistence | Pass | Existing auth cookie and committed row survived restart of celld, PostgreSQL, and both MinIO services. The rolled-back row remained absent. [Restart result](../../experiments/celld-slice/evidence/05-restart.json). |
| Base Agent construction | Pass | A fresh DO contained the real SDK tables before any Cerebro table. |
| OpenCode on empty application storage | Pass | The control returned a healthy embedded runtime. |
| Agent plus OpenCode | Pass with patch | The real Agent initializes OpenCode and preserves its session ID between requests. |
| Dynamic Worker egress | Pass | Direct fetch to a reachable fixture was denied. The supplied gateway binding returned fixed JSON with status 200. Its handler did not make an outbound request. |
| Drizzle Durable SQLite with the composed SDKs | Pass | Cerebro tables and a completed operation created before OpenCode initialization survive its bootstrap. |
| Deterministic model loop and conversation isolation | Pass | One fixture tool completes and the exact final reply returns. A second conversation has a distinct session ID and no messages. This is not cross-company authorization coverage. |
| Existing session after ordinary restart | Pass | Session ID, messages, and completed operation survive. Retry returns the stored result without new messages. [Session restart evidence](../../experiments/celld-slice/evidence/12-session-restart.json). |
| Stream reconnect and real provider | Not run | No real provider key was supplied. |
| Broker, approval, replay, and remote-effect recovery | Not run | The pure fixture tool is not an approved-effect broker. Those checks remain separate work. |
| Durable wake-up and failure-boundary recovery | Not run | No crash recovery claim is made. Ordinary service restart coverage is separate. |
| Positive TLS and private-CA runtime probes | Not run | The local database uses plaintext. Source inspection shows a fixed Mozilla trust store. No trusted TLS PostgreSQL endpoint was configured. |
| Credentialed browser requests | Not run | Only protocol-level CORS and cookie checks ran. |
| One-session and ten-session measurements | Not run | Probe durations are not agent capacity measurements. |

The unmodified OpenCode permission service also stores pending approvals in memory. Cerebro still needs durable approval records. The source shows a plugin readiness mechanism, but plugin registration relative to restart replay remains untested. Neither observation is treated as a reproduced bypass.

The initial fresh Compose project started with empty volumes and reproduced the unpatched composition failure. Evidence files 01 through 04 retain historical `incomplete` gate labels from an earlier report script. Their individual failing results remain valid. Evidence 06 uses the current `fail` gate rule. The restart and clean deployment checks were driven by separate host commands; their entries in the main check registry remain `not-run`.

## Guarded dependency patches

[`scripts/patch-dependencies.mjs`](../../experiments/celld-slice/scripts/patch-dependencies.mjs) changes only the `workerd` password export in `@better-auth/utils@0.4.2`. It selects that same package's JavaScript implementation. The native Node export stays unchanged.

The patch checks the package name, exact version, and expected export map. It is idempotent and rejects unexpected input. Native and JavaScript implementations cross-verified hashes in an isolated Node check. The deployed Worker passed the real cookie flow after the patch. This proves the patched configuration only.

The same script now applies the OpenCode census patch. `rtk proxy node experiments/celld-slice/scripts/check-patches.mjs` verifies idempotence, exact table names, rejection of changed versions and original or patched source, and preservation of all other migration code. Both patches remain local compatibility patches; no upstream release or production qualification is claimed.

## Reproduce

Run from this worktree root.

```sh
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml up --build -d --wait
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm check
```

Startup is expected to succeed. The check is expected to exit 1 with an `incomplete` gate while unproved criteria remain. It writes detailed JSON to the ignored `experiments/celld-slice/results` directory. The executed loop and schema checks are recorded separately from the unrun broker and recovery checks.

[The experiment README](../../experiments/celld-slice/README.md) includes the separate restart commands. The check service has no Docker socket. Host commands own service restarts. No Worker imports process-control APIs.

All credentials in this experiment are public fixture values. Ingress binds to `127.0.0.1:18765`. This is a local compatibility experiment, not a production deployment.

## Work allocation and principles

One owner controlled deployment, dependencies, and the evidence. Read-only source inspection and design comparison ran in parallel. Delegates edited separate API, session, tool, and patch files. The first run stopped at the composition dependency. The user then authorized the narrow OpenCode patch. Approval and crash-recovery logic remain outside this fix.

Type System Discipline kept request bodies unknown until validated and kept runtime storage APIs typed. Model the Domain shaped the report's explicit pass, fail, and not-run states. Prove It Works required real Worker requests and the empty-storage control before recording the incompatibility. The design chose one Compose project with staged probes and a required final combined check.

The next action is to complete the remaining Session 0 checks. Do not start Session 1 until the full gate passes.

## Independent review

A read-only review by GPT-6 Sol confirmed the reproduced composition blocker. It used a different model variant within the same family. Review fixes added complete preflight assertions, clarified the untested artifact storage and gateway limits, and replaced raw Session errors and main-check response dumps with bounded messages. Only the exact known schema conflict is retained. The fresh-project result was rerun after these fixes.

[The initial validation record](../../experiments/celld-slice/evidence/07-validation.md) contains exact commands and exits. Scoped Ultracite formatting and lint checks and the container TypeScript check passed. The repository-wide pre-commit formatter was bypassed to keep all changes inside the Session 0 paths.

The experiment services were stopped after verification. Named volumes and local results were retained. Real-provider credential redaction remains unqualified; the fixtures use no private provider credentials.

A second read-only review found no actionable defects in the OpenCode patch or migration assertions. It confirmed the exact-name allowlist and unchanged migration branches. It also required the receipt to distinguish legacy marker import from historical schema upgrades, and object re-creation from the host restart commands.

[The patch validation record](../../experiments/celld-slice/evidence/14-patch-validation.md) contains the final commands, exits, image ID, and restart provenance. It includes a new-volume startup, container TypeScript and patch checks, and the scoped Ultracite check.
