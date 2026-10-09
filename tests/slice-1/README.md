# S1-D deterministic infrastructure

Branch: `codex/cerebro-slice-1-deploy-fixtures`. Source baseline: `f583d09a78885c43758eae0e022f707f0e2e7065`.

This packet prepares deployment and fixture infrastructure. It does not qualify the assembled Pi application. The frozen contract selects PiHarness + Lifecycle, Effect 4.0.1 and celld `0.6.1@sha256:acb0bc2dca628f0dac7c6b43eea42615a79f4943f316f6df7c1da0b86d52150b`. Native Stop withdraws pending inputs. No Cerebro execution queue is added.

## Boot and cleanup

From the checkout root, after S1-F supplies the server configuration and wiring:

```sh
rtk proxy node tests/slice-1/boot.mjs --project cerebro-s1-local --api-port 28765 --web-port 4001 --fixture-port 28090
```

The boot combines the production `compose.yaml` with `tests/slice-1/compose.test.yaml`. The test file adds the fake provider (`fixture`, built from `tests/slice-1/Dockerfile`) and a `test-config` step that writes an ordinary local `runtime.json` pointing at it. The application runs in local mode; it has no test mode or test routes. Setup uses the generated bootstrap token, which `applicationFixture().bootstrapToken()` reads from the secret volume. `initializeFixtureAgent` ingests the pilot source through the memory API. Append `--fixture-only` to start only the provider. `--dry-run` validates the generated isolated Compose configuration without starting containers.

Every boot requires a fresh `cerebro-s1-*` project, distinct explicit ports and project-owned volumes. It labels its containers and volumes `cerebro.slice-1=disposable`. Images, fixture identity, tested SHA and boot configuration are saved in `artifacts/slice-1/<sha>/<project>/boot.json`. The fixture stores counters in a separate `slice-1-fixture` directory within that project's disposable celld volume. The seven retained stores are unchanged. Ports remain bound to loopback.

```sh
rtk proxy node tests/slice-1/boot.mjs --project cerebro-s1-local --api-port 28765 --web-port 4001 --fixture-port 28090 --down
```

Cleanup checks ownership labels and removes only the selected project's containers and volumes. It refuses projects containing protected resources. Do not run Docker prune. If HEAD changed since boot, append `--state-sha <sha-from-boot-report>` to find that boot's override. Failed boots retain their state for inspection; use the same scoped cleanup command.

In the managed cloud environment, set `BUILDX_CONFIG=/tmp/cerebro-s1-buildx` when the default buildx directory is read-only. Preserve Docker registry credentials and inherited proxies. Boot forwards `CODEX_PROXY_CERT`, when provided, as a BuildKit public CA secret. Networked application build steps use it without baking the session certificate into the image or disabling TLS. This checkout's environment has no `rtk`; equivalent commands ran directly.

## Provider protocol

The provider has no agent loop and no authority implementation. It emits OpenAI-compatible `/v1/chat/completions` responses, suitable for a controlled Pi provider adapter. Use `Bearer fixture-model-key`. A call's identity is `X-Fixture-Request-Id` when present, otherwise a digest of the messages up to the last user message, so one user turn keeps one identity. Physical calls are never deduplicated. Retries retain the same identity and increment counters. `X-Fixture-Purpose: compaction` emits a fixed summary and records that purpose. The provider requests a registered tool once when the last user message names it: `fixture_effect` or "approval fixture" selects the write, `fixture-read` selects the read. `X-Fixture-Tool` overrides that choice. After a tool result it emits text. Streaming emits separate delayed text frames before EOF. Defaults are 100 ms per frame and no injected failure.

`POST /mcp` accepts a JSON-RPC fixture read. `POST /effects` accepts a write with `operationId` and JSON arguments. Both require `Bearer fixture-connector-key`. Repeated identical writes count as repeated physical effects; the provider does not mask a duplicate dispatch by the runtime. Changed input under the same identity returns 409. These are disposable effects only.

`GET /health` and `GET /observations` are read-only. Observations read the committed state file after pending atomic replacements finish and expose model requests, tool dispatches, first-token/completion timestamps, checkpoints, revision, fixture identity and SHA. They omit request bodies and credentials. State rejects reuse under a different fixture identity or source SHA.

Control requests require `X-Fixture-Control: slice-1-control`:

```json
{
  "delayMs": 100,
  "failFirst": true,
  "arm": { "boundary": "after-tool-dispatch", "operationId": "write-A" }
}
```

Send this to `POST /control`. `failFirst` returns one 503 for each stable model identity/purpose before succeeding. `{"release":true,"arm":null}` releases held checkpoint responses. `/control` cannot execute Docker commands or kill an arbitrary process.

The provider holds a connector response at its own `before-tool-dispatch` and `after-tool-dispatch` checkpoints, so a test can kill celld while a physical write is in flight. `POST /checkpoints` exists only for the provider self-test.

To arm a boundary and kill only this fixture stack's celld process:

```sh
rtk proxy node tests/slice-1/boot.mjs --project cerebro-s1-local --api-port 28765 --web-port 4001 --fixture-port 28090 --kill-at after-tool-dispatch
```

Start this monitor before driving the scenario in a second terminal. It waits up to 60 seconds, identifies a newly armed checkpoint by a unique token, checks container ownership, sends SIGKILL and saves counters and the killed container identity. A timeout leaves the host running. Release the barrier and start celld with the generated Compose override to test recovery. Do not poll history during an alarm-only recovery interval; observation could trigger recovery itself.

## Probes and seeded scenarios

```sh
node tests/slice-1/probe.mjs --self-test
rtk proxy node tests/slice-1/probe.mjs --fixture-url http://localhost:28090 --scenario fixture --output artifacts/slice-1/fixture.json
rtk proxy node tests/slice-1/probe.mjs --base-url http://localhost:28765 --scenario performance --output artifacts/slice-1/performance.json
```

The infrastructure probe measures early text relative to EOF and asserts retry, compaction, tool request, read, repeated physical write, changed-input conflict, read-only reconciliation and all ten checkpoint barriers. Self-tests additionally kill a real provider child after dispatch, reload its committed evidence and use the shared frozen Effect authority fake for cross-company denial and revocation. The unchanged `pnpm test:contracts` covers bound approvals and native Stop/inbox semantics. No local port copies are introduced.

`scenarios.json` supplies stable seed identities and cases for foreign-company history, committed access revocation, changed approval arguments, queued operation withdrawal, retired OpenCode work, recovery/restore and performance. These are scenario inputs, not claims that application state has been seeded successfully. Application scenarios return `blocked` and exit 2 until S1-F supplies a driver:

```sh
node tests/slice-1/probe.mjs --base-url http://localhost:28765 --fixture-url http://localhost:28090 --fixture-id cerebro-s1-head --baseline-fixture-id cerebro-s1-trunk --baseline-sha TRUNK_SHA --scenario performance --driver /absolute/path/to/integrated-driver.mjs --output artifacts/slice-1/performance.json
```

The driver exports `runScenario({baseUrl, fixtureUrl, scenario, configuration, sha})`. It seeds an authenticated fixture user/company/agent through the real adapters and drives the frozen SessionService commands, not a second model loop. The performance result must include `metrics`, ten alternating baseline/head raw `samples` with their source SHAs, `attachDetachCycles: 100`, ten accepted and ten terminal concurrent turns. The probe enforces the frozen numeric budgets and requires permission/projection timing and idle memory. Keep fixture transport timing distinct from provider-to-browser adapter delay. Warm up before samples; use identical host settings and label unavailable baseline capabilities.

## Compose, backup and evidence

```sh
rtk proxy docker compose config --quiet
rtk proxy docker compose --env-file tests/slice-1/compose-validation.env -f compose.yaml -f compose.production.yaml config --quiet
node --test tests/integration/backup.test.ts
```

The validation environment uses fixture credentials, `.invalid` public URLs and verified PostgreSQL TLS. It is for parsing only and must never be deployed. Server-only secret volumes, private host bindings, readiness probes, PostgreSQL, both object stores and the web service are retained. OpenCode census patches, implicit OpenCode model defaults and local balance seeding are removed; the independent hash/version-guarded Better Auth compatibility patch remains. An explicit server-only `runtime.json` is now required in every deployment mode.

`deploy/backup.mjs` still snapshots all seven complete volumes without filtering tables or object keys. Use its backup/restore commands with the generated fixture Compose override. Restore into a fresh project, at the archive's Git SHA, with the recorded image override and no rebuild. The seven-store archival test proves byte preservation and safe ownership, not live Pi recovery. S1-F must seed and restore actual Cerebro command/approval/receipt/projection records, Pi private checkpoints and Lifecycle jobs, object artifacts and the retirement fence, then check authorized history and zero repeated writes. Production bind-mounted secrets retain the existing manual quiescent-backup requirement.

## Coordinator change requests and blocked checks

1. Remove required local budget/pricing fields from `apps/server/src/runtime-configuration.ts` and provide explicit unpriced local and fixture runtime configuration through server-only secrets. This packet does not alter that shared schema or synthesize a budget to satisfy it.
2. Replace the isolated `tests/runtime/package.json` and lock with the selected Agents 0.26.0, Pi Durable/Pi AI 1.0.4 and Effect 4.0.1 dependencies when the runtime worker switches. Its existing legacy install graph remains unchanged in this branch; no replacement versions are guessed locally.
3. Wire stable provider request headers, fixture checkpoint calls at real commit boundaries, and application seeding/scenario drivers in S1-F. No public frozen Effect port change is requested. Use the shared fakes until those adapters land.

`pnpm test:boot`, integrated API/web fixture readiness, browser/performance lanes, real celld crash handoff, alarm-only recovery and live Pi backup/restore remain blocked on server/runtime wiring. They must run at the final integrated SHA. No merge or deployment is performed by S1-D.

The packet checks passed during implementation: both Compose configuration parses, isolated fixture Docker boot, three provider/Effect-fake self-tests, 50 shared contract tests, all four backup tests (including the real Docker seven-volume round trip), scoped Ultracite lint/format, and whitespace review. Final handoff reruns write logs and fixture image identities under `artifacts/slice-1/<returned-sha>/`. The performance command records a blocked report and exits 2 until an integrated application driver is supplied.
