# S1-0 thin official PiHarness fixture

The operator selected **official PiHarness + Lifecycle on retained celld with `nodejs_compat`**, and then chose to reuse Pi's native inbox, steering and Stop semantics through a thin Effect adapter. The latest-version direction now requests celld **0.6.1**, pinned by image digest in `dependency-requests.json`. This supersedes the previous Cerebro admission queue and the original requirement to preserve queued inputs during active Stop. S1-0 is ready for coordinator review with explicit deferred checks; this fixture is not a replacement application adapter.

Exact latest direct pins remain Effect 4.0.1, Pi Durable / Pi AI 1.0.4, Agents 0.26.0, TanStack AI 0.65.0 / AI Client 0.37.0 / AI React 0.29.5, direct AG-UI 1.0.2, React 19.3.0 and TypeScript 7.0.2. Registry metadata and the current tag recheck are under `evidence/`. TanStack still pins AG-UI 1.0.0 transitively; both copies are recorded.

Run from the repository root:

```sh
node tests/pi-durable-qualification/run.mjs
```

Use `S1_0_EVIDENCE_DIR=/absolute/output/directory` for artifacts. `S1_0_NPM_CACHE=/absolute/cache/directory` optionally reuses downloaded tarballs while performing a fresh integrity-checked `npm ci`. The runner creates an isolated install, checks all resolved package names for `ai` and `@ai-sdk/*`, inventories exports/peers/dependencies/licenses, runs twelve Effect contract tests, isolated TypeScript 7 signatures and the headless TanStack lifecycle, then starts disposable plain Durable Objects on retained celld. It removes only its own containers and retains local proof data. No production credentials are used. `rtk` is absent, so commands run directly.

`wrapper-worker.mjs` calls public PiSession submit, steer, abort, wait, events and messages, and PiHarness pending. Lifecycle installs the official wrapper and owns storage integration, jobs and alarms. The fixture has no execution admission table, pump/drive dispatcher, host admission job or custom alarm. Its only Cerebro tables are diagnostic counters/transcripts for a controlled faux provider and one harmless replay-safe registered tool. It never edits Pi-private tables or implements a model/tool loop.

The native cases verify:

- Stable operation IDs deduplicate submission. Pi retains the first payload when the same ID is reused with changed text; it does not return Cerebro's required changed-input 409. The Cerebro command journal retains full-intent and mode conflict checks.
- Pi queues follow-ups and executes them in order.
- Steering joins both operations to the same physical Pi run after a controlled tool round.
- Withdrawing queued B leaves active A running.
- Active Stop withdraws queued inputs. The original stronger preservation case remains an executed FAIL with an operator-approved semantics change, not a vendor queue defect.
- Native abort followed by submit stops A and completes replacement B in the same conversation. This route has no durable replacement retry protocol; crash/retry between the two calls remains NOT_RUN.
- The functional alarm-only recovery probe leaves the worker without HTTP requests for ninety seconds after process kill/restart, then reads a snapshot before any blocking wait. It requires no live run or inbox and two saved answers whose timestamps precede the observation request, then verifies both operations settled. The default celld cold-alarm discovery scan runs every sixty seconds; ninety seconds allows that scan and the controlled work to finish. This is not a sixty-second production recovery/performance PASS. No custom scheduler or waker configuration is added.

Current results and exact counts are recorded in `evidence/qualification.json`. The source inspection and targeted three-case investigation are under `evidence/recovery-investigation/`: default alarm-only recovery passed on 0.6.0 and 0.6.1, and request-triggered resume passed on 0.6.1. These were local-store process-restart cases, not separate idle-eviction or production-fleet tests. The original forty-five-second FAIL remains archived under `evidence/native-recovery-45s/`; the earlier strict twenty-second FAIL is under `native-recovery-20s/`. The development probe that used blocking HTTP waits after twenty seconds never established alarm-only completion. Historical results are not relabelled.

The strict Node-free bundle remains FAIL; the selected host uses `nodejs_compat`. The runner intentionally exits nonzero while original failed constraints and unrun checks remain. Operator-authorized preparation proceeds with the limitations listed in `todos.json`. No complete qualification PASS is claimed.

Effect ports add a submission mode in Cerebro terms and a native session Stop returning affected states. The command fake checks input/mode conflicts, replacement phase ordering, replay without another Stop, and Pi acceptance before every acknowledgement. Wake timestamps and separate wake-registration transitions are removed. The command journal exists to repair handoff/product projection, not to schedule a second queue. Approval and uncertain-effect receipt protections remain.

`tanstack.test.mjs` uses public `stream(factory, { hydrate, joinRun })` and ChatClient attach/detach/dispose. Approval notification and reattachment produce zero submissions and no leaked observers. This is headless API evidence, not browser acceptance.

The previous direct adapter is historical under `historical-direct/`. Older evidence is retained under `evidence/previous-effect3/`, `previous-effect4/` and `previous-admission/` with original SHAs. It does not qualify current code.

The coordinator owns all application manifests/catalogs/locks. Requests remain in `dependency-requests.json`; the isolated install lock is proof data. Root contract tests still run the existing 35 cases until the coordinator adds the proposed suite. Fresh workspace type/build checks await that dependency commit. Metering remains an unbound external port, spend control through it is inactive, and native Python is outside scope. No S1-A through S1-D implementation, merge or deploy is included.
