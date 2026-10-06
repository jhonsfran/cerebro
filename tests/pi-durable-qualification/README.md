# S1-0 official PiHarness fixture

The operator selected **official PiHarness + Lifecycle on retained celld 0.6.0 with `nodejs_compat`** on 2026-10-06, and authorized inexpensive fixes with unresolved qualification retained as TODOs. Contracts are ready for coordinator review; runtime qualification remains partial. This branch implements a disposable qualification fixture, not the replacement application.

The fixture uses the latest published S1-0 pins recorded on 2026-10-06: Effect 4.0.1, Pi Durable / Pi AI 1.0.4, Agents 0.26.0, TanStack AI 0.65.0 / AI Client 0.37.0 / AI React 0.29.5, direct AG-UI 1.0.2, React 19.3.0 and TypeScript 7.0.2. `evidence/registry-latest.json` records publication metadata. TanStack still pins AG-UI 1.0.0 transitively; the proof records both copies.

Run from the repository root:

```sh
node tests/pi-durable-qualification/run.mjs
```

The coordinator is requested to expose this as `test:pi-durable:qualification`; application manifests remain untouched. `rtk` is absent, so commands run directly. The runner creates a fresh isolated npm install from the proof lock, scans all resolved names for `ai` / `@ai-sdk/*`, inventories exports/peers/dependencies/licenses, runs the ten Effect fake tests and isolated TypeScript 7 checks, verifies the public TanStack lifecycle, and starts a disposable plain Durable Object on the retained image. It uses persistent local celld-dev storage, ephemeral loopback ports and no production credentials.

Use `S1_0_EVIDENCE_DIR=/absolute/output/directory` for saved artifacts. `S1_0_NPM_CACHE=/absolute/cache/directory` optionally reuses downloaded tarballs while still performing a fresh integrity-checked `npm ci`. The runner removes only its own containers and leaves the temporary install and evidence for review.

`wrapper-worker.mjs` uses public PiHarness `submit`, `pending`, `wait`, `abort` and factory hooks with an explicit empty tool registry and a controlled faux provider. The host uses Lifecycle's `onStart`, `onRequest`, `onJob` and host `jobs.push` APIs, so startup and physical alarms remain with Lifecycle. It does not manipulate Pi-private tables or implement a provider/tool loop.

The small cancellation workaround retains later runs in `cerebro_admissions` and hands Pi one run at a time. Active cancellation completes before another handoff. Cancelling host-queued B never invokes Pi and leaves active A alone. A queued receipt accepts durable host admission plus a persisted Lifecycle wake, while `engineAccepted` remains false. Retry of an ambiguous handoff uses the original ID and saved input. The host job stays pending while admissions remain outstanding, including when Pi itself is idle.

The runner checks duplicate admission, changed-input conflict, active A cancellation followed by B completion, queued B cancellation without stopping A, and process kill/restart followed by an interval with no HTTP requests. Physical faux-provider counters and stable admission IDs are retained. This proves only the executed local-host cases, not production bucket flush, remote tool outcomes, individual handoff crash boundaries, permissions or Effect interruption.

Raw Pi-queued cancellation is kept as a separate failing reproducer: the published wrapper withdraws queued follow-ups when aborting an already-placed operation. The strict Node-free bundle also remains FAIL. The selected strategy uses host admission and celld compatibility mode; these two results do not become PASS because they are accepted/documented limitations. The runner exits nonzero while failed or unrun checks remain. That result no longer prevents operator-authorized preparation and coordinator review. `todos.json` records the remaining work.

The previous direct-storage prototype is retired from the default runner. Historical source is retained under `historical-direct/` and evidence remains available for diagnosis; there is no direct runtime dependency edge or fallback flag. Earlier Effect 3 and Effect 4 proof results are under `evidence/previous-effect3/` and `evidence/previous-effect4/` with their original SHAs. They do not qualify new code.

`tanstack.test.mjs` uses public `stream(factory, { hydrate, joinRun })` handlers and ChatClient attach/detach/dispose. Another observer's approval notification and reattachment produce zero submissions and no leaked observers. This is headless API evidence, not browser acceptance.

The contract fakes expose Layers for session, engine, storage, authority, tool execution and receipts. The updated host fake acknowledges durable queued admission after wake registration and requires engine acceptance for an active acknowledgement. The external meter has no fake or live binding; spend control through it is inactive.

All application dependency changes remain requests in `dependency-requests.json`. `evidence/isolated-install-lock.json` is generated proof data, not the workspace lockfile. Root `pnpm test:contracts` still runs the existing 35 tests until the coordinator adds the proposed ten-test suite. Fresh application type checks require the coordinator dependency commit. No S1-A through S1-D application work, merge, deployment or native Python is included.
