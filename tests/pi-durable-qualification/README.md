# S1-0 qualification fixture

This is a disposable qualification experiment and proposed contract suite. It is not the replacement runtime. Both tested Pi candidates failed required behavior; **there is no selected adapter and no frozen contract commit**.

Run from the repository root:

```sh
node tests/pi-durable-qualification/run.mjs
```

The coordinator is requested to expose this as `test:pi-durable:qualification`; root manifests are deliberately untouched. `rtk` is absent in this environment. The runner creates an isolated temporary npm install from the retained evidence lock, scans all resolved names for exact `ai` / `@ai-sdk/*`, inventories installed exports/peers/dependencies/licenses, runs Effect fake/type and public TanStack probes, builds disposable workers, and starts the **retained celld 0.6.0 digest**. It uses isolated local celld-dev storage and ephemeral loopback ports. It kills/restarts only its direct probe container and removes only containers it created. No production credentials or infrastructure are used. It leaves the evidence directory and temporary install for review.

Use `S1_0_EVIDENCE_DIR=/absolute/output/directory` to choose the evidence directory. A nonzero exit is intentional when a candidate fails or a required check remains unrun. `qualification.json` lists individual outcomes and the tested source SHA. FAIL means an executed check failed. NOT_RUN means no evidence was produced. An isolated install, bundle, memory fake or headless client pass never qualifies celld durability or browser behavior.

`wrapper-worker.mjs` uses published `PiHarness` + `Lifecycle` on a plain DO with an explicit registry and a controlled faux provider. The wrapper needs celld's `nodejs_compat` for `node:async_hooks` and `node:diagnostics_channel`; a strict browser bundle without those externals fails. It starts on the retained image, but its active-operation abort drains the queued operation too.

`direct-worker.mjs` uses published portable `SqliteStorage`, a serialization/transaction facade in `sqlite.mjs`, and persisted host alarms. It bundles without Node imports and coexists with `cerebro_probe`. Its raw `abortTask` experiment leaves queued B stalled. A completed cancellation claim must not be inferred from an aborted generation receipt. It has not qualified admission/wake/flush or crash-handoff semantics. It is rejected as implemented and has no application dependency edge.

`conformance-worker.mjs` runs all 23 upstream portable storage cases in fresh celld objects, plus real rollback and unrelated-operation serialization checks. Each case uses a separate object. The callback facade is qualification-only; do not copy it into S1-A without full host qualification and coordinator contract review.

`tanstack.test.mjs` uses the published ChatClient with `stream` handlers `hydrate` and `joinRun`. It verifies attach, detach, reattach and another observer's approval notification while counting zero submissions and no leaked observers. This is a Node/headless API test, not browser acceptance.

`contracts.test.ts` tests proposed Effect contracts and typed fakes. The fakes expose Layers for session, engine, storage, authority, tool execution and receipts. They are in-memory or scripted test doubles and cannot establish crash persistence, provider dispatch guarantees, or production policy. The external meter intentionally has no fake/live binding.

Saved terminal transcripts remove ANSI color and trailing whitespace; counters and JSON results retain their values.

All package/manifests/lockfile changes are requests in `dependency-requests.json`. `evidence/isolated-install-lock.json` is the exact generated isolated install snapshot, retained as proof data, not an application lockfile. Root `pnpm test:contracts` still runs the existing 35 tests; the proposed coordinator script also includes the eight new tests. Fresh workspace Effect resolution remains blocked pending that owner change.
