# S1-0 contracts and official PiHarness selection

Status: **ready for coordinator review; official PiHarness selected with deferred qualification**. On 2026-10-06 the operator chose the official harness, requested a small inexpensive fix, and authorized carrying unresolved checks as TODOs rather than stopping development. This supersedes the S1-0 stop/fallback gate for preparation; it does not turn failed or unrun checks into passes. ADR 0001 remains proposed. The coordinator can publish the reviewed contract and dependency commits for later packets. This task does not execute S1-A through S1-D, merge or deploy.

The selected integration is **`agents/harness/pi` PiHarness + `agents/lifecycle` Lifecycle on retained celld 0.6.0 with `nodejs_compat`**. Pi's operation-specific abort becomes a conversation abort once input is placed, withdrawing Pi-queued follow-ups. Cerebro therefore durably admits later human runs before handing them to Pi, and hands off at most one run per conversation. Cancelling a host-queued run never reaches Pi. Active cancellation finishes before the next handoff. Pi retains its transcript, model/tool loop, retries, private storage and engine-owned inbox; Cerebro owns admission order, not another agent loop.

The qualification fixture exercises this admission strategy through public PiHarness submit/pending/wait/abort methods and public Lifecycle host jobs. It is a small proposed host protocol, not an application adapter. No Pi-private table is edited and no raw task abort is used. The old direct adapter is retired from the default runner; its evidence remains historical. Deferred work and accepted deviations are recorded in `tests/pi-durable-qualification/todos.json`.

The source baseline is `1855fed13aafee0e7a3369f3e684564f35715086`. The default branch was resolved with `git ls-remote --symref origin HEAD`, then its `AGENTS.md` was read with `git show origin/main:AGENTS.md`. Baseline install, 35 contract tests, and forced build and type checks ran. Baseline lint failed; exact file/rule pairs are in `tests/pi-durable-qualification/evidence/baseline-lint.json`. `rtk` is unavailable: commands ran directly through pnpm/Node. There is no remote coordinator integration branch, so no packet PR target exists.

See `tests/pi-durable-qualification/README.md`, its dependency requests, and the recorded qualification report for commands, pins, image identity, tested source SHA and blocked cases. Do not promote headless API or contract-fake tests to browser, production bucket, crash-handoff, approval durability, or performance passes.

## Effect boundaries

The user requested the latest Effect 4 release and latest S1-0 dependencies on 2026-10-06. The proposal now uses **Effect 4.0.1**: `Context.Service` keys, array-based `Schema.Union` and `Schema.Literals`, schema checks, and `Effect.result` / `Result` in the fakes suite. TypeScript **7.0.2** checks the isolated signatures. Service methods, typed failures and ownership remain the same.

Every effect has a typed error channel and no implicit application environment. Layers select services. `ExecutionEngine.open`, `SessionService.stream` and `SessionStore.attach` require `Scope.Scope`; vendor resources remain in those implementations. An observer scope owns its subscription, while a host-owned scope owns durable work. Vendor promises, Pi contexts, SQLite connections, alarms and UI protocol types do not appear in these ports. Existing data modules and the old Promise interfaces remain available for the preparation step; final removal belongs to S1-F.

| Module / method | Inputs and success | Failure channel |
| --- | --- | --- |
| `SessionService.submit` | Existing submit command + `EffectOptions` → existing `SessionReceipt` | `ContractFailure` |
| `SessionService.approve` | Existing approval command + required run identity and allow/deny decision + options → `RunState` | `ContractFailure` |
| `SessionService.cancel` | Existing run-specific cancel command + options → `RunState` | `ContractFailure` |
| `SessionService.inspect` | `EventAddress`, trusted `ExecutionContext`, `ReadOptions` → `DomainSnapshot` | `ContractFailure` |
| `SessionService.stream` | Same address/context, `ObservationRequest` and options → scoped `Stream<Observation>` | `ContractFailure` |
| `ExecutionEngine.open` | Address, pinned `AgentDefinition`, read options → scoped `EngineConversation` | `ContractFailure` |
| `EngineConversation.submit` | `EngineSubmission` (request ID, run ID, canonical digest, envelope), read options → run ID and replay marker | `ContractFailure` |
| `EngineConversation.inspect`, `observe` | Read options → run states / scoped domain update stream | `ContractFailure` |
| `EngineConversation.approve`, `cancel` | Bound approval / exact run ID, read options → run state | `ContractFailure` |
| `EngineConversation.release` | No arguments → void, idempotent resource cleanup | `never` |
| `AuthorityService.evaluate` | `AuthorityRequest`, read options → existing allow/deny `AuthorizationDecision` | `InvalidInput` or `Unavailable` |
| `AuthorityService.require` | Same request/options → `AuthorityPermit` with policy version and evaluation time | `Denied`, `InvalidInput` or `Unavailable` |
| `ToolExecutor.execute` | Bound call, bound capability, effect options → existing `ToolExecution` | `ContractFailure` |
| `ToolExecutor.reconcile` | Operation ID, trusted context, read options → evidence-backed `ToolExecution` | `ContractFailure` |
| `ToolReceiptStore.claim` | Full `EffectIntent`, effect options → `ReceiptClaim` with replay flag | `ContractFailure` |
| `ToolReceiptStore.read` | Company/operation key, current context, read options → authorized receipt | `ContractFailure` |
| `ToolReceiptStore.dispatch` | Key, expected revision, optional bound approval, effect options → `DispatchClaim` and sole dispatch winner | `ContractFailure` |
| `ToolReceiptStore.recordOutcome` | Key, confirmed outcome, effect options → persisted immutable outcome receipt | `ContractFailure` |
| `ToolReceiptStore.complete` | Key, effect options → completed receipt, only after confirmed outcome | `ContractFailure` |
| `ToolReceiptStore.unknown` | Key, reason, optional provider receipt, effect options → unknown receipt | `ContractFailure` |
| `SessionStore.admit` | Envelope, pinned agent, effect options → atomic `DurableHandoff` | `ContractFailure` |
| `SessionStore.commit` | Address, expected domain revision, typed handoff transition, effect options → committed handoff | `ContractFailure` |
| `SessionStore.receipt`, `recover`, `snapshot` | Stable request / address and options; reads include context → receipt / pending handoffs / domain snapshot | `ContractFailure` |
| `SessionStore.attach` | Address, context, observation request, options → scoped snapshot plus updates | `ContractFailure` |
| `ExternalMeter.reserve` | Company/operation/idempotency key, raw usage evidence, effect options → opaque reservation | `ContractFailure` |
| `ExternalMeter.settle`, `release`, `lookup` | Opaque reservation and evidence / reservation / key, options → provider reservation state | `ContractFailure` |

`ContractFailure` is the closed union `Denied`, `InvalidInput`, `Conflict`, `Unavailable`, `NotFound`, `UnknownOutcome`. Each is an Effect `Data.TaggedError`. The code defines their complete fields. `failureToHttp` is the single conversion before response headers: 403, 400, 409, 503, 404 and 409 respectively. Authentication adapters still distinguish absent credentials with 401 before an authenticated application call. Unknown outcome is never successful cancellation. Adapter exceptions must enter the typed channel, not become successful output or a policy allow.

## Identity, authority and approvals

Company identity uses the existing `OrganizationId`; conversation, session, agent, run, event, operation, principal, delegation and digest IDs retain their branded meanings. A stable request uses the existing event ID; a new engine attempt must not allocate a new request or run identity. The coordinator derives context from verified credentials and current grants, never from client-supplied claims. Deadlines and caller signals limit waiting; Effect interruption must also reach vendor invocation contexts and abort signals. Neither proves a remote write did not happen.

`AuthorityRequest` carries current context, address, action/resource, pinned agent and optional model/registered tool. Enforcement intersects current actor or delegation, represented principal, pinned agent, enabled models and tools, company/content grants and connector restrictions. Recheck before **each physical** model request, retry, compaction call and tool dispatch, after approval waits and before receipt/history reads. Denial is decision data from `evaluate`; `require` converts it to `Denied`. Unavailable authority fails closed. Fakes provide scripted allow/deny/unavailability; they do not implement production policy.

The existing `Approval` remains untouched. The proposed `BoundApproval` adds required `runId` and `connectorFingerprint`; corresponding `BoundInvocation`, `RegisteredTool` and `BoundCapability` require the same fields. A fingerprint is SHA-256 of canonical JSON containing connector registration ID, configured version and configured destination. Normalize destinations when registering connectors; do not use a client destination. Reuse the existing JSON argument digest rules. Matching additionally compares company, agent, operation, tool/version, effect, argument digest, actor, represented principal, delegation, policy version and strict expiry. The approver remains subject to current approval authority; matching alone does not grant authority. Focused tests mutate run, registration, arguments, identity, policy and expiry, and check that version/destination changes change the fingerprint.

## Receipts and durable handoff

Receipt state is `claimed → dispatched → outcome → completed`, with `dispatched → unknown → outcome` for evidence-based reconciliation. No monetary states occur here. Claim compares the full immutable intent, not only the argument digest. Dispatch compares the current revision and yields one winner; repeats return `dispatch:false`. Writes require a matching approval and current authority. Unknown non-idempotent effects block the same intent even under a new occurrence ID until read-only provider evidence resolves it. The unresolved-intent key uses company, run, pinned agent, tool/version, connector fingerprint, effect kind, argument digest, actor, represented principal and delegation identity; it excludes occurrence ID and policy version. A policy update cannot bypass an unresolved effect. Reconciliation never invokes the effect. Completion and confirmed outcomes are immutable. Durable receipt recording after dispatch must run in a host-owned scope despite caller interruption; that adapter behavior is unqualified.

A handoff stores address, pinned version, full envelope, canonical input digest, stable request/run IDs, admitted/current revision, run state, approvals, wake timestamp, engine acceptance, acknowledgement and projection revision. The proposed queued acknowledgement point is **after durable Cerebro admission and persisted Lifecycle wake registration**. A queued receipt accepts host responsibility while `engineAccepted` remains false. The coordinator hands that run to Pi only after the current run is terminal; an active receipt additionally requires durable engine acceptance. Returning a queue acknowledgement without a persisted wake is invalid. Production bucket flush before acknowledgement remains a deferred check. No network operation runs inside an atomic storage transition.

Recovery must repair, in order:

1. Admission committed but wake missing: register a Lifecycle admission job. Once acknowledged, retain queued admissions through recovery; hand off the original request/run only when no prior engine run remains active.
2. Pi accepted but the Cerebro acceptance marker missing: inspect by stable identity and repair it.
3. Cancellation committed before the vendor stop completes: keep later runs in Cerebro admission, resume stopping only the recorded active run, and hand off the next run after the current one is terminal.
4. Wake persisted but acknowledgement missing: return the original queue receipt on retry. Acknowledged host-queued work still needs recovery; acknowledgement does not imply Pi accepted it.
5. Pi completed but projection missing: project canonical output and tool outcomes without resubmitting.

Transitions include engine acceptance, wake registration, acknowledgement, bound approval, run state and domain projection. Projection must atomically persist canonical output, required confirmed tool outcomes and terminal run state/outbox. No final success is conditional on metering. Each transition needs a real crash injection. The fixture **has not individually qualified these five crash boundaries**. The operator deferred them for continued development. Keep their TODOs open and distinguish the local process-restart experiment from production durability or remote-effect guarantees.

## Observation schemas and ordering

`DomainSnapshot`, `DomainUpdate` and `Observation` are runtime Effect schemas in `session-service.ts`. Snapshot fields are address, positive pinned agent version, nonnegative durable revision, existing run states and canonical outputs with content dependencies and existing provenance citations. Updates are run state, provisional text, canonical output, tool progress/outcome, approval request or citation. Tool/citation/output content carries existing source/tool dependencies. Citation notifications and canonical outputs carry existing full provenance (source ID/version/URI and observation time). Tool output must be valid canonical JSON.

Every observation has schema version 1, address, nonempty ephemeral epoch, nonnegative sequence and access generation. Snapshots have an attach/overflow/reconnect reason and full domain snapshot. Updates have a domain revision and validated update. Access denial has an explicit revoked/unauthorized reason and contains no protected content.

Proposed ordering rules:

- Allocate durable revision only for committed domain changes. Provisional text uses the most recent durable revision; sequence orders all frames within an epoch. Repeated revision is permitted only for provisional progress, never as a substitute for a missing committed update.
- Attach by subscribing and buffering **before** reading the canonical snapshot, or by an equivalent atomic host operation. Send the snapshot at revision R first; discard buffered committed updates at or below R; emit each later commit in order. A run completing during attachment must appear in the snapshot or following updates.
- Each attachment or resnapshot creates a fresh epoch with sequence 0. The client validates address and access generation before applying any content; it rejects old epochs, old generations and duplicate sequences. On a sequence or durable revision gap, close that observer and obtain a fresh canonical snapshot.
- Overflow replaces the observer buffer with a fresh authorized snapshot and epoch. Never silently drop committed updates and continue. No durable UI chunk log is promised. Canonical outputs replace provisional output by run identity; snapshots replace protected canonical state.
- Revalidate access while active and idle. Before headers, convert `Denied` to HTTP; after headers, emit a validated `access-denied` notice then close. The client invalidates company/session caches, clears protected output, increments its local access generation, drops delayed old-generation frames and stops automatic reconnect. It resumes only after a new explicit authorized attachment. The one-second revocation budget belongs to later acceptance, not a measured S1-0 pass.

## Qualified public TanStack API and remaining adapter work

At the proposed pins, use `stream(factory, { hydrate, joinRun })` from `@tanstack/ai-client`. The public connection handler is `hydrate(threadId, options?) → Promise<ChatHydrationResult>` with messages, active run pointer and interrupts; it is **not** a `ChatClient.hydrate()` method. `joinRun(runId, signal?) → AsyncIterable<StreamChunk>` is observation of existing work. `ChatClient.attach(): void` starts hydration/tailing with `persistence:true`; `detach(): void` closes observation; `dispose(): void` releases the client. `setMessagesManually` can replace canonical messages inside the protocol adapter.

The headless published-client probe verifies construction opens no connection, attach hydrates/joins, detach removes observers, reattach hydrates/joins again, and an external approval notification continues the same run with zero `connect` submissions. It checks final assembled text and zero observers. It does not run React or a browser, enforce domain access generations, prove a race-free server attachment, or test wire reconnection faults.

S1-C must use Cerebro custom approval events while continuing to observe an approval-waiting run. Hydrating TanStack's own pending interrupts suppresses joining that run; do not introduce its separate resume/tool loop. All submit/approve/Stop actions call Cerebro commands. `detach`, EOF, rehydrate and `joinRun` never submit, approve or cancel. Do not use TanStack `chat`, AI SDK, `StreamDurability`, built-in byte replay, or model/tool client callbacks. Implement custom canonical resnapshot and reconnect through these public handlers, with an adapter-specific generation guard before TanStack processes a frame. Real browser qualification remains required.

## Dependency ownership and deferred work

`dependency-requests.json` contains exact latest published versions, scripts and the proposed coordinator-owned AG-UI package/tsconfig/exports. The registry snapshot on 2026-10-06 selects Effect **4.0.1**, Pi Durable / Pi AI **1.0.4**, Agents **0.26.0**, TanStack AI **0.65.0**, AI Client **0.37.0**, AI React **0.29.5**, AG-UI **1.0.2**, React / React DOM / their types **19.3.0**, Node types **26.6.4**, esbuild **0.28.2**, and TypeScript **7.0.2**. These are exact npm `dist-tags.latest` selections, not GitHub main references. The Cloudflare [2026-10-02 PiHarness release](https://developers.cloudflare.com/changelog/post/2026-10-02-pi-harness/) is included in Agents 0.26.0; its plain DO `PiHarness` + `Lifecycle` integration remains the first qualification candidate.

TanStack AI still declares AG-UI **1.0.0** as an exact transitive dependency. The isolated graph retains that publisher constraint alongside the requested direct AG-UI **1.0.2** instead of downgrading the direct request or forcing an override. Transitive packages resolve within their published compatibility ranges and are captured in the generated proof lock. The installed inventory records exports, peers, dependencies, integrity and licenses; optional architecture packages absent on this machine are distinguished from installed packages. Shared React and compiler catalog updates require coordinator application checks. This S1-0 proposal does not upgrade unrelated existing application dependencies.

Current qualification evidence uses these latest pins. Earlier proofs are retained under `evidence/previous-effect3/` and `evidence/previous-effect4/` with their tested SHAs. The Node-free wrapper bundle remains an executed failed check and is marked as an accepted deviation for the chosen compatibility mode. The raw Pi-queued cancellation failure remains reproducible and is documented as a vendor limitation. Neither changes status to PASS because the selected strategy uses host admission.

The fixture writes generated manifests only into its isolated temporary directory and retains its install lock as evidence JSON. It does not edit application manifests, the pnpm lockfile or the old runtime's isolated install. A local temporary Effect link is used for direct development checks; a fresh application type/build check requires the coordinator's dependency commit. Focused proofs run from the isolated pinned install. That distinction is part of the blocked handoff.

`ExternalMeter` has no live Layer or application binding. Reserve/settle/release/lookup exchange opaque provider handles, idempotency keys and raw usage evidence. No local pricing, balance, reservation authority or settlement is added. **Spend control is not active through this port.** Historical budgets and migrations remain unchanged. No native Python or Node worker, runtime caller migration, S1-A through S1-D implementation, merge or deployment is included.
