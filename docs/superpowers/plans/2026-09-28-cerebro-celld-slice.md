# Cerebro celld slice implementation plan

> **For agentic workers:** Use the local `executing-plans` skill for this session. Check a box only when the deployed runtime produced the recorded result.

**Goal:** Prove that the selected stack can execute and recover one controlled agent conversation on celld.

**Architecture:** Deploy a normal Hono Worker and a session DO in one celld application. Connect the Worker to PostgreSQL and the runtime to MinIO. Use the Agents SDK base `Agent` with one embedded OpenCode loop.

**Tech stack:** Pinned celld, PostgreSQL, MinIO, Hono, Better Auth, Drizzle, Cloudflare Agents SDK, and OpenCodeWorkerd.

---

## Prepare the experiment

Use branch `codex/celld-feasibility`. Own only `experiments/celld-slice/**`, necessary dependency declarations, and `docs/implementation/session-0.md`.

Create these files as the experiment develops:

| Proposed file | Responsibility |
| --- | --- |
| `experiments/celld-slice/compose.yaml` | Isolated services, networks, health checks, and persistent volumes |
| `experiments/celld-slice/Dockerfile` | Pin and build the runtime and experiment dependencies |
| `experiments/celld-slice/package.json` | Declare the exact experimental dependencies and check command |
| `experiments/celld-slice/wrangler.jsonc` | API Worker, DO, and dynamic Worker bindings |
| `experiments/celld-slice/src/api.ts` | Hono routes, real auth, and DO routing |
| `experiments/celld-slice/src/auth.ts` | Better Auth with PostgreSQL |
| `experiments/celld-slice/src/database.ts` | PostgreSQL connection and Drizzle transaction probe |
| `experiments/celld-slice/src/session.ts` | Agents SDK, OpenCode, and persistent session mapping |
| `experiments/celld-slice/src/ledger.ts` | Minimal event and tool execution records |
| `experiments/celld-slice/src/tool.ts` | Restricted dynamic Worker and trusted gateway |
| `experiments/celld-slice/fixtures/provider.ts` | Deterministic model responses and a counted remote effect |
| `experiments/celld-slice/scripts/bootstrap.mjs` | Repeatable database, bucket, and Worker setup |
| `experiments/celld-slice/scripts/check.mjs` | Black-box probes and process-failure orchestration |
| `docs/implementation/session-0.md` | Versions, commands, observed results, and verdict |

- [ ] Pin every image and relevant package version. Record the celld build or commit and the host platform.
- [ ] Verify the native celld deployment command against that release. Use `wrangler.jsonc` and local endpoints.
- [ ] Add an isolated Compose project. Use separate MinIO storage for runtime state and application artifacts.
- [ ] Add a `check` service that exercises the deployed Worker and can request controlled failures through test-only hooks.
- [ ] Keep process control outside the Worker. Do not assume `node:child_process`, a persistent filesystem, or a Node HTTP server inside celld.

## Prove the API and PostgreSQL path

`nodejs_compat` is an intent in the Worker configuration, not proof of compatibility. celld documents partial Node support and accepts many flags without changing behavior. Exercise actual APIs. [celld compatibility](https://celld.dev/docs/cloudflare-compat/)

- [ ] Deploy Hono as a normal Worker and call its health route through celld ingress.
- [ ] Invoke the chosen PostgreSQL driver from that Worker. Read and write through Drizzle.
- [ ] Execute a transaction that commits and a transaction that rolls back. Observe the rows through a separate PostgreSQL connection.
- [ ] Test repeated requests and idle periods. Confirm that connection handling obeys celld's event lifetime.
- [ ] Test TLS with certificate verification for the production connection mode. Record any private-CA limitation.
- [ ] Create a Better Auth user, sign in, read the session, sign out, and verify denial using the old session cookie.
- [ ] Test invalid credentials, untrusted origins, and credentialed browser requests. Keep local cookie settings separate from production settings.
- [ ] Restart the services without deleting volumes. Verify that the auth record and committed database row remain.

**Pass condition.** Auth and database operations work from the deployed Worker. A successful Node container connection does not satisfy this condition.

If the first driver fails, test a documented Workers-compatible transport. Do not add a database proxy or move the API to Node without reporting the failure and the added dependency.

## Prove the agent composition

- [ ] Instantiate the Agents SDK base `Agent` on celld. Create two session DOs with different conversation IDs.
- [ ] Embed OpenCodeWorkerd using the version and storage API from the celld example. Preserve its session ID across requests.
- [ ] Persist Cerebro records through `drizzle-orm/durable-sqlite` without modifying SDK-owned tables.
- [ ] Send a deterministic prompt through the real OpenCode loop and the fixture model endpoint. Require one tool call and a final answer.
- [ ] Read the final result through the API. Verify that the other conversation cannot see it.
- [ ] Disconnect the client during execution. Reconnect using the same application operation ID and retrieve the run state.
- [ ] Repeat the prompt with a configured non-production model provider. Record this result separately from fixture coverage.

**Pass condition.** The real SDKs run together in celld. OpenCode owns the loop. The DO owns durable application state. Persisted state survives a process restart.

If approval or restart support requires a library patch, record the exact patch and version constraint. Do not claim compatibility by replacing the model loop with a mock.

## Prove that tools cannot bypass the ledger

- [ ] Register one tool through the actual OpenCode tool path. Disable any built-in shell, network, file, or MCP path that avoids the broker.
- [ ] Persist a stable invocation ID and argument digest before executing the tool.
- [ ] Execute the tool wrapper in a dynamic Worker with `globalOutbound: null`. Provide one narrow service capability to the fixture gateway.
- [ ] Verify that an ungranted direct HTTP request fails. Verify that no connector secret appears in tool input or output.
- [ ] Pause a fixture effect for approval. Verify that no effect occurs before the explicit approval event.
- [ ] Repeat the approval and tool result delivery. Verify one logical effect and one result in the ledger.

**Pass condition.** Every enabled tool path is mediated. An SDK hook that observes a completed call is insufficient.

The dynamic Worker isolates the wrapper. A remote MCP server still executes its implementation on its own host. [celld dynamic Workers](https://celld.dev/docs/services/dynamic-workers/)

## Prove restart and replay behavior

- [ ] Kill celld after an event is stored but before the model starts. Verify that durable recovery resumes it.
- [ ] Kill celld while the run waits for approval. Verify that the request remains pending after restart.
- [ ] Kill celld after the fixture provider commits an effect but before the DO stores the result.
- [ ] Retry with the same provider idempotency key. Verify that the counted effect remains one.
- [ ] Run the same failure with a provider that has no idempotency support. Verify an unknown-outcome record and no automatic retry.
- [ ] Kill celld after the ledger commits completion but before the client receives it. Retry the request and retrieve the stored result.
- [ ] Verify that a persisted alarm or other selected durable wake-up resumes work without a new user message.
- [ ] Restart MinIO and PostgreSQL independently. Verify explicit retryable failures, preserved state, and recovery after readiness returns.

**Pass condition.** The experiment reports each failure boundary correctly. A ledger does not claim exactly-once execution across an external system.

## Run and record the checks

Provide these commands through the experiment's Compose configuration:

```sh
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml up --build -d --wait
rtk proxy docker compose -p cerebro-slice -f experiments/celld-slice/compose.yaml run --rm check
```

The `check` command must exit nonzero on a required failure. It must emit a result for each API, database, auth, agent, tool, and recovery criterion. Store logs without credentials.

- [ ] Record the start command, check command, head SHA, exact versions, and hardware in `docs/implementation/session-0.md`.
- [ ] Record latency, memory, and PostgreSQL connection counts for one session and ten concurrent isolated sessions. Treat these as an initial baseline, not a production capacity claim.
- [ ] Repeat the checks after a clean rebuild and after an ordinary restart with preserved volumes.
- [ ] Record pass, fail, or not run for each provider check. A missing model key leaves the real-provider check incomplete.
- [ ] State the minimum required patch set, if any, and whether it is acceptable for the next session.

Proceed to session 1 only after the required runtime checks pass. If a credential is unavailable, finish the deterministic probes and report the remaining provider check explicitly. Do not mark the full gate passed until the agreed required checks have evidence.

## Read the pinned upstream behavior

Use the [celld OpenCode example](https://github.com/denoland/celld/tree/main/examples/opencode) as the integration starting point. Check the exact release source when behavior differs from the current documentation.

Read the [Agents API](https://developers.cloudflare.com/agents/runtime/agents-api/), [celld Durable Objects](https://celld.dev/docs/services/durable-objects/), and [Drizzle Durable SQLite guide](https://orm.drizzle.team/docs/get-started/do-existing) before writing adapters. These sources guide the experiment. The experiment establishes whether the selected versions work together.
