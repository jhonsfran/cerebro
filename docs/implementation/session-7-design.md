# Session 7 candidate A

## Problem

The deployed product uses Session 6 presentation fixtures. It does not call SessionAgent. SessionAgent itself permits only the controlled fixture model and tool. Production composition needs one trusted Worker that connects the existing ports and retains the proved tool gateway state owner.

The architecture document assigns conversation authority to the session Durable Object. PostgreSQL owns identity, agent versions, shared budgets, searchable memory, and projections. MinIO owns artifacts. OpenCode owns the model loop. The Session 2 and Session 4 receipts require durable intent before dispatch, current permission on replay, and conservative unknown outcomes. Those constraints apply to the integrated path.

The following sketch is a proposed design. It is not a claim that the loader or provider hooks passed an integration check.

## Usage

The API composes the existing SessionService from real adapters within its database scope.

```ts
await withDatabase(env, async (database) => {
  const services = createTrustedServices(database, config);
  const sessions = createSessionService({
    namespace: env.SESSIONS,
    agentRepository: services.agents,
    authorizationPolicy: services.authorization,
    entitlementPolicy: services.entitlements,
  });
  return sessions.submit(command, options);
});
```

SessionAgent composes ports at the operation boundary. It never captures a closed PostgreSQL connection in a long-lived OpenCode plugin.

```ts
const journals = createSessionJournals(this.ctx.storage);
const runtime = createSessionRuntime({
  config,
  journals,
  ledger: this.storage(),
  loader: this.env.LOADER,
  gateway: this.env.TOOL_GATEWAY,
  withServices: (run) =>
    withDatabase(this.env, (database) =>
      run(createTrustedServices(database, config))
    ),
});
await runtime.resume(run);
```

The restricted wrapper receives the tested TOOL_GATEWAY service capability. The same Worker exports the thin TrustedGateway entrypoint and the persistent GatewayJournal Durable Object used by the Session 4 proof. The gateway owns its dispatch journal and current approval lookup. Its signature, audience, complete tool claim, deadline, registry fingerprint, and current policy remain mandatory.

The strict version of candidate A used the owning SessionAgent stub as the loader gateway. Reject that version for this integration. It adds an unproved reentrant callback path. The revised candidate retains direct composition for policy, budgets, memory, and audit, but accepts the already proved gateway DO seam. This is a concrete runtime constraint, not a requirement to move other trusted ports behind RPC.

Memory routes use the same trusted service factory. The application router factory receives `createMemoryRouter(database => createTrustedServices(database, config).memoryApi)`. Product routes receive session, budget, catalog, source, and audit adapters. ChannelDispatcher runs in both deployment modes.

## Shape

The named data shape is `TrustedInstallation`. Configuration parsing creates it once. The discriminated deployment mode prevents deterministic providers from entering production configuration. Configuration is private to server composition.

```ts
type TrustedInstallation =
  | {
      readonly mode: "fixture";
      readonly providers: FixtureProviders;
      readonly common: InstallationConfig;
    }
  | {
      readonly mode: "production";
      readonly providers: VerifiedProviders;
      readonly common: InstallationConfig;
    };

interface InstallationConfig {
  readonly organizationId: OrganizationId;
  readonly models: ReadonlyMap<string, ModelRegistration>;
  readonly tools: ToolRegistry;
  readonly budget: BudgetConfiguration;
  readonly objects: ObjectStorageConfiguration;
}

interface ModelRegistration {
  readonly id: string;
  readonly configurationVersion: string;
  readonly contextTokens: number;
  readonly outputTokens: number;
  readonly maximumResponseBytes: number;
  readonly maximum: BudgetAmount;
  readonly provider: VerifiedHttpProvider;
}

interface TrustedServices {
  readonly authorization: AuthorizationPolicy;
  readonly entitlements: EntitlementPolicy;
  readonly budget: BudgetAuthority;
  readonly agents: AgentRepository;
  readonly memory: MemoryService;
  readonly artifacts: ArtifactStore;
  readonly memoryApi: MemoryApiServices;
  readonly project: (event: ProjectionEvent) => Promise<void>;
}

interface SessionJournals {
  readonly model: OperationJournal<ModelHttpReceipt>;
  readonly decision: OperationJournal<DecisionResult>;
  readonly broker: ToolOperationJournal;
}

interface ModelHttpReceipt {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly usage: VerifiedModelUsage;
}

function parseInstallation(env: WorkerEnv): TrustedInstallation;
function createTrustedServices(
  database: Database,
  config: TrustedInstallation
): TrustedServices;
function createSessionJournals(storage: DurableObjectStorage): SessionJournals;
function createSessionRuntime(
  dependencies: SessionRuntimeDependencies
): SessionRuntime;
```

The sketch uses existing contract types where they exist. `TrustedInstallation`, `ModelRegistration`, `ModelHttpReceipt`, and `SessionRuntime` are proposed server-private types. Provider headers, credentials, SQLite schemas, and HTTP hook types stay behind their owning modules. Model the Domain motivates the mode union and explicit durable journal states. Boundary Discipline motivates config parsing and provider receipt parsing at their entry points.

### Module ownership

| Module | Knowledge it owns |
| --- | --- |
| `apps/server/src/services.ts` or adjacent `runtime-services.ts` | Trusted adapter construction, configuration choice, database lifetime, connector secret resolution. |
| `apps/server/src/env.server.ts` | Strict installation configuration and production rejection of fixture providers. |
| `packages/runtime/src/session-agent.ts` | Agent lifecycle, one model loop, durable wake, admission, approval, cancellation, and resume. |
| `packages/runtime/src/operation-journal.ts` | Atomic journal claims and transitions in the existing cerebro_operation table. Separate model, decision, and broker record namespaces. The gateway DO owns a separate journal. |
| `packages/runtime/src/opencode-adapter.ts` | OpenCode config, HTTP hooks, bounded provider request and response receipt, denied built-in tools, and plugin installation. |
| `packages/runtime/src/ledger.ts` | Run and invocation identity, pinned grants, source dependencies, stream records, and durable outbox. |
| `packages/tools` | Tool normalization, current policy, approval binding, signed capabilities, restricted loader execution, MCP transport, and gateway receipt lookup. |
| `packages/policy` | Paid-work accounting and decision semantics. Existing local budget, Unprice, Jev, and router remain reusable. |
| `packages/channels` | Trusted user context, current product reads, real catalog and source presentation, channel projections, and Slack delivery. |
| `deploy` and `tests/integration` | One Worker with SessionAgent and ChannelDispatcher, loader configuration, real local services, restore, and deployed acceptance. |

`createTrustedServices` is a deep factory. It hides configuration choice and adapter construction behind domain ports. It does not add HTTP wrappers to policy, memory, budgets, or audit. No public factory exposes intermediate reserve or parse stages. The loader gateway remains a real isolation boundary because it strips ambient capabilities and validates signed claims.

### Provider admission

Reserve and settle every provider HTTP request. A reservation around `session.prompt` alone misses subsequent model requests and provider retries.

The runtime grounding reports supported SDK `session.hook` handlers for `http.request` and `http.response`. The request hook precedes dispatch and sees the same request object as the response hook. Those hooks disable websocket transport. Bind all model requests to the configured HTTP provider and disable metadata model fetches.

Use `createPaidWork<ModelHttpReceipt>` with a request and response rendezvous. The request hook allocates a durable provider operation sequence within the run. It binds the normalized request digest, pinned model, verified maximum, and configuration version. It starts paid work and waits until the work callback confirms durable dispatch. Only then can the SDK send HTTP. Each intentional model call gets a distinct sequence even if its body equals an earlier call.

The response hook reads the full response within the configured byte and time limits. It parses authoritative provider usage. It completes the rendezvous with a JSON receipt. PaidWork records the outcome and settles usage before the hook releases a reconstructed response to OpenCode. This bounded buffering avoids a deadlock where settlement waits for a stream that OpenCode cannot read yet. It also delays provider token streaming until receipt completion. The pilot accepts that latency tradeoff.

Every request maps to one lifecycle record. On transport failure, cancellation, or client close without a response, complete the pending rendezvous with unknown usage. The durable full maximum stays held. A failed HTTP response with valid usage settles that incurred usage. A missing or invalid usage field cannot become zero cost.

Restart scans paid journal records before it starts another model attempt. It settles known outcomes and releases unused reservations through their original command identities. A dispatched operation without a trusted receipt stops the run in unknown-outcome. Restart cannot allocate a fresh request to bypass that hold. Known recorded receipts can restore output through the supported OpenCode state. Any response replay mechanism must be verified against the actual installed hooks before it is enabled.

### Tools, decisions, and memory

Preserve SDK call identity and Session 2 invocation mapping. The pinned enabled tool IDs and agent grants limit the registry. Current principal and connector grants further limit execution. Read-only tools proceed without an artificial approval. Approved fixture writes retain the exact approval state machine.

The OpenCode plugin replaces all built-in tools with registered broker tools. A broker invoke persists its intent before the restricted dynamic Worker starts. The wrapper has `globalOutbound: null`. Its only binding is the gateway Fetcher. Only the trusted gateway resolves connector secrets and calls the configured provider. The broker journal belongs to SessionAgent. The gateway journal belongs to the proved GatewayJournal DO. Propagate an approval through its tested trusted interface before gateway dispatch. Recheck current policy on both sides.

Jev user decisions use a decision journal and the paid-work gate. Deterministic approval, cancellation, revocation, and maintenance handlers cannot invoke Jev. Missing Jev configuration selects the explicit deterministic local decision policy. Missing Unprice configuration selects the real PostgreSQL budget authority and configured deny-by-default entitlement catalog.

Memory uses the real PostgreSQL repository and MinIO object store in both modes. Full-text retrieval is the local default. Enable semantic retrieval only with a configured embedding provider. Paid embeddings require their own admission and journal integration if the selected provider bills requests.

Add citation and tool variants to SessionStreamItem. Store source dependencies with generated output. Check current source access before cached output, citation, transcript, or Slack delivery. Outbox projection writes those records and usage to PostgreSQL with stable event IDs. ACK follows successful projection. Budget settlement and projection export remain distinct operations.

## Synthesis decision

This is candidate A. The coordinator selects the base after comparison. Reject the strict direct-gateway version because it depends on an unproved callback path. The revised candidate recommends direct trusted composition for shared ports and the already proved service-bound gateway DO for dynamic Worker isolation.

## Tradeoffs accepted

- We accept direct coupling between the server composition root and package factories in exchange for fewer RPC contracts and fewer state owners.
- We accept one gateway DO and approval propagation in exchange for the loader capability path already proved in Session 4. Gateway recovery and session recovery have separate journal owners.
- We accept bounded model response buffering in exchange for receipt persistence and accounting before response publication.
- We accept conservative unknown-outcome holds in exchange for no unproved provider retry and no unreported spend.
- We accept short database scopes per sensitive operation in exchange for current policy reads and no long-lived closed database handles.
- We accept explicit configured catalogs in exchange for production agent creation that cannot register arbitrary provider destinations.

## Alternatives considered

A gateway service architecture can expose current policy, budgets, memory, audit, and tools through WorkerEntrypoint bindings. It hides credentials and database adapters from SessionAgent. It also adds transport DTOs, error parsing, and deployment bindings for trusted calls that already share one Worker. A separate gateway Durable Object introduces another journal owner and approval synchronization path. Candidate A accepts the existing tool gateway state owner because its loader capability path is proved. It rejects extra RPC policy, memory, budget, and audit services because their trusted factories can run directly.

A whole-run paid reservation has a small API, but hides too little policy. The caller must know how many provider calls OpenCode makes and how retries behave. Per-request HTTP admission protects the actual dispatch boundary.

Keeping Session 6 synthetic sessions in fixture mode reduces immediate changes. It leaves local acceptance on a different execution path and cannot prove production composition. Candidate A uses deterministic external HTTP providers with the same real orchestration and storage as production.

## Red flag screen

The factory owns configuration and adapter lifetime. It is not a pass-through module. The session owns all conversation operations and their recovery. It is not a sequence of load, validate, transform, and save modules. HTTP and SQLite shapes remain private. The TrustedGateway entrypoint exists because the loader requires a concrete capability. It keeps the proved Session 4 gateway seam.

## Gates and tests

1. Run the existing actual celld loader fixture after porting the proven gateway seam. Send a signed read and a denied ambient fetch. Assert a literal provider result and a network failure. Do not add a reentrant session route.
2. Probe actual OpenCode HTTP hooks with a provider that emits two model calls and one retry. Read its independent request log and PostgreSQL account. Assert one bounded reservation per dispatched HTTP request and exact incurred totals.
3. Disconnect after provider dispatch and before response receipt. Restart celld. Assert one provider effect, unknown-outcome, held maximum, and no new model dispatch.
4. Boot an isolated Compose project. Authenticate through Better Auth and submit through the deployed product API. Assert a real SessionAgent run, controlled MCP result, PostgreSQL citation, MinIO bytes, and one usage projection.
5. Replay exact events and invocation IDs. Assert literal provider effect counts, exported row counts, and budget balances. A changed digest must conflict.
6. Revoke a principal or source grant while work waits. Resume model, tool, approval, output replay, and queued Slack delivery. Assert denial or withheld source content. Pair denial tests with an allowed case that returns a literal result.
7. Race two sessions against one real shared account. Assert the exact remaining balance and total reserved maximum. Failed work with valid usage still settles.
8. Kill after a non-idempotent write effect. Assert reconciliation state and no blind retry. Verify fixture receipt lookup for the idempotent recovery case.
9. Restore PostgreSQL, MinIO artifacts, and celld runtime state into fresh volumes. Verify auth, session ledger, projected transcript, source visibility, and exact artifact bytes.
10. Run affected contracts, scoped lint and format, workspace types, build, and frozen install. Record repository-wide pre-existing failures separately.

Test Behavior, Not Implementation motivates independent provider counters, literal database balances, and API entry points. Laziness Protocol motivates the direct factories and rejection of additional shared-port RPC layers.

## Required storage gate

The guarded OpenCode patch preserves only `cerebro_session` and `cerebro_operation`. Session journals must use the existing `cerebro_operation` table with record kinds and namespace keys. Do not add a SessionAgent table that the SDK storage census can wipe. Keep legacy Session 0 rows readable through kind-filtered queries. GatewayJournal has no OpenCode storage owner and can retain its separate migrated tables.

`deploy/patch-dependencies.mjs` currently patches auth only. The coordinator identified the hash-guarded storage census patch in the former experiment, now at `tests/runtime/scripts/patch-dependencies.mjs`. The production Docker build must resolve the pinned OpenCode dependency and apply the equivalent guarded patch. A hash mismatch stops the build. Run migration and real SDK reopen checks before acceptance. New deployments and upgrades must test this production patch, not only the experiment runner.

## Risk verdict

Reject strict candidate A as an implementation base. Its same-session loader callback is not proved. The revised candidate is viable with the existing Session 4 gateway state owner. Per-request model accounting remains the largest new correctness risk. Its hook lifecycle must fail closed under missing response, cancellation, and restart. PostgreSQL connection scopes must not survive in cached SDK plugins.

## Open questions and risks

The original direct-stub gateway has an unresolved loader and reentrancy risk. The revised candidate avoids it through the already proved service binding and gateway DO.

Do installed model HTTP hooks expose all transport failures and permit response replacement after bounded reads? The second gate resolves this observable question.

Can a known stored model receipt resume supported OpenCode state without another charge? Until a check proves that path, fail closed at an unresolved model boundary.

Live configured providers still require live checks. Unconfigured optional providers are not applicable. Publicly trusted Worker PostgreSQL TLS remains unverified under the inherited receipts. Fixture tests cannot close that gate.

## Next implementation step

Promote the proved operation journal semantics into cerebro_operation and compose the existing tool gateway seam, then verify model HTTP admission.

## Evidence

Read in the pilot-integration worktree on 2026-09-30. Source includes `apps/server/src/index.ts`, `channel-services.ts`, `services.ts`, `packages/runtime/src/session-agent.ts`, `session-service.ts`, `opencode-adapter.ts`, `packages/tools/src/dynamic-worker.ts`, `mcp-gateway.ts`, `opencode-plugin.ts`, `packages/policy/src/authorization-gate.ts`, `packages/db/src/index.ts`, `packages/api/src/routers/memory.ts`, `packages/channels/src/service.ts`, and `types.ts`. Session 2 and Session 4 receipts, the delivery plan, and the architecture decisions establish the retained invariants. `/tmp/cerebro-s7-runtime-ground.md` and `/tmp/cerebro-s7-ports-ground.md` identify the remaining production composition gaps. The coordinator supplied the installed SDK hook trace and storage census constraints before this sketch.

# Session 7 arena judgment

I read both candidate files in full. This agent wrote candidate B, so this report is a rubric-based comparison rather than a second independent model opinion. No application files changed.

## Recommendation

Use candidate A as the base. Keep its direct trusted factories, per-request paid-work rendezvous, short database scopes, and one SDK recovery owner. Use the existing tested Session 4 named tool gateway and separate gateway DO instead of A's unproved callback into the active SessionAgent. Graft B's storage guard and content dependency rules.

Do not add B's model ingress capability, multi-worker credential split, or separate ToolBroker DO for this pilot. Those structures require new transport protocols without a demonstrated runtime need. SessionAgent is trusted in A. The restricted dynamic Worker must still have only GATEWAY and `globalOutbound: null`.

## Scores

Scores assess the files as written. Five is strongest. They do not claim a native test passed.

| Criterion | A | B | Reason |
| --- | --- | --- | --- |
| Durable dispatch, current ACL, and accounting correctness | 4 | 4 | Both bind per-request identity, hold unknown maxima, save receipts before settlement, and recheck current policy. A omits the SDK table preservation constraint. B adds unproved route state and uses byte arrays in journal-facing data that need a JSON representation. |
| Reuse of proven SDK and celld forms | 4 | 3 | A uses the reported HTTP hooks and existing factories directly. Its direct DO loader callback still needs a probe. B uses proven gateway DO forms but adds unverified cross-worker deployment and model ingress rewrite. |
| Smallest maintainable interface | 5 | 2 | A concentrates composition and avoids transport DTOs for trusted local ports. B adds policy, model, tool, memory, and projection boundaries plus prepared request capabilities and more state owners. |
| Native verifiability | 4 | 4 | Both specify real product API, counters, balances, crash fences, and restore tests. A needs request rendezvous and callback checks. B needs those tests plus ingress and cross-worker graph checks. |
| Fixture uses production orchestration | 5 | 5 | Both use the real SDK session, PostgreSQL policy and budgets, MinIO memory, and production journal semantics. Only external HTTP responses differ. |
| Total | 22 | 18 | A is the smaller base. B has useful security and durability details that do not require its full graph. |

## Grafts

Keep the following changes coherent within A.

- Use production SessionAgent journals inside `cerebro_operation`, with separate kinds and namespace prefixes. The reported SDK census preserves only `cerebro_session` and `cerebro_operation`. Gateway DOs without SDK storage can use separate migrated tables.
- Apply the hash-guarded OpenCode storage patch in the production Docker artifact. Resolve installed package paths rather than assume fixture paths. Reject unexpected dependency hashes. Prove journal state survives SDK initialization and restart.
- Store every source supplied to the model as an output dependency, even if the final answer has no citation. Retain tool dependencies when their output contributes content. Recheck dependencies on cached transcript, output, citation, stream emission, and queued Slack delivery.
- Reuse the tested named tool gateway and gateway DO. Keep the broker journal in SessionAgent. Keep the gateway journal in its distinct DO. A stable immutable approval receipt binds both owners to the same operation, input digest, tool version, approver, policy version, and expiry. Current denial remains authoritative.
- Validate input byte and token bounds, output token caps, response byte bounds, pricing version, and budget unit at model dispatch. Output caps alone do not prove a maximum. A malformed usage receipt remains unknown rather than zero.
- Provision the first owner, active connector, and company budget from a trusted setup command. SSO claims do not create privileged roles or balances. Production publication validates immutable agent versions against the real configured catalog.
- Export company-filtered authoritative reservation and settlement data separately from eventual audit and usage projections. Check current export policy. Report projection progress and retain stable event IDs.
- Treat `unknown-outcome` as a terminal projected run with an explicit reconciliation state. Do not leave the channel dispatcher waiting for completion forever.

## Reject or revise

B's credential-free session worker is a valid future security design. It is not required to prove this trusted-worker pilot. Its model capability route creates another sensitive ingress and replay protocol. Remove that route from the selected design.

B's separate ToolBroker DO adds invocation and approval coordination that the session broker already owns. Keep broker identity and SDK state together.

A's direct owning-session loader callback is unproved and can introduce reentrant lifecycle behavior. The tested Session 4 service and gateway DO are the safer baseline. A thin entrypoint is justified by the real capability boundary. It is not a reason to wrap memory, policy, or budget factories in RPC.

Neither candidate proves response replacement or transport failure coverage merely by naming HTTP hooks. Test that the request hook waits for the durable dispatch fence. Test that the response hook completes accounting before the SDK consumes reconstructed bytes. Test that request failure or cancellation completes pending work as unknown.

Use JSON-safe model receipts in OperationJournal. A's string body is suitable. If preserving binary data, store a bounded encoded string and validate its format at the transport boundary. Do not persist Request, Response, stream objects, or Uint8Array through JSON without an explicit representation.

Do not implement stored model response replay until the installed SDK can resume from that receipt without another charge. The initial implementation can stop ambiguous work for reconciliation. Known accounting can complete even when current policy denies returning content.

## Native gates before broad implementation

1. Run a controlled SDK prompt through the reported HTTP hooks. Prove one bounded reservation for each actual HTTP dispatch, including tool-driven continuation and automatic retry.
2. Interrupt after the dispatch fence and before the response receipt. Restart. Prove no new request, a held maximum, and explicit unknown-outcome.
3. Record a valid response receipt, interrupt before settlement, and resume. Prove one settlement and the same immutable receipt.
4. Deploy the tested named tool gateway and restricted WorkerLoader form in the actual app graph. Prove gateway access and denial of direct outbound fetch.
5. Initialize OpenCode against a ledger with journal rows. Restart the production Docker artifact. Prove those rows and SDK state survive.

These gates decide observable runtime questions without asking the user. The selected design remains A with the grafts above. A failed gate requires redesign of the affected boundary rather than speculative infrastructure across the whole application.
