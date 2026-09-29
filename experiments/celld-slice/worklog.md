# Session 0 work log

## Prototype checklist

1. Scope the decision the prototype exists to make: which layout, which interaction, which density, or for an empirical fork which behavior, timing, or approach. No decision means no prototype. Route to Feature. Decision: can celld 0.6.0 run and recover the specified stack?
2. Gather references when the design space is open. Search for prior art, summarize a moodboard of themes, palettes, and layouts, let the user pick directions before building. Skip when the direction is set. Skip visual references. Use the pinned celld example and runtime source.
3. Build throwaway in an isolated scratch dir, separate from production source. For a visual decision, vanilla HTML/CSS/JS or the lightest stack that renders the idea, CDN deps, a dev server with hot reload. For a behavioral or timing decision, the smallest script that exercises the question. No production framework, no tests, no abstractions. Use experiments/celld-slice. The requested runtime checks override the generic no-tests suggestion.
4. When comparing alternatives, build them behind one switcher (buttons or a keypress), each variant labeled. This is the **exhaust-the-design-space** principle skill made cheap. Compare PostgreSQL transports with named probe results if the first fails.
5. Verify on the matching surface. For a visual decision, screenshot each variant via the control skill and drive the interaction. For a behavioral or timing decision, observe the thing you are deciding by logging the timing, printing the output, or watching the render. The observation is the test here, not an assertion. Exercise the deployed Worker through celld ingress.
6. Present alternatives, tradeoffs, and a recommendation. The output is the decision plus the throwaway artifact, not shippable code. Hand the chosen direction to **Feature** (or `architect` for the shape) for the real build. Record the runtime verdict in docs/implementation/session-0.md.

## Throughput checkpoint

- Blocking first steps. Pin the release, inspect APIs, start native deployment, then test the Worker transport.
- Independent workstreams. Read-only source inspection and design comparison can run in parallel.
- Shared mutable state. One owner edits the experiment. Compose uses the cerebro-slice project and its own volumes.
- Smallest safe decomposition. Keep one implementation owner until the runtime works. Recovery tests share one process and run in sequence.

## Design comparison checklist

- [x] Frame. Compare staged probes with one composed experiment. Judge reproducibility, actual runtime coverage, failure diagnosis, and implementation size.
- [x] Fan out.
- [x] Cross-judge.
- [x] Pick.
- [x] Graft.
- [x] Verify.

The runtime verification produced a failed gate. See evidence/06-fresh-project.json and evidence/07-validation.md. The prototype decision is to stop dependent work at the shared database initialization conflict. No production feature or PR is part of this run.

## OpenCode compatibility fix

1. Reproduce it yourself on the matching surface via the control skill (Non-negotiables). Done. Evidence 06 records the real celld failure on new volumes.
2. Binary-search the cause. Done. Agent tables fail; empty application storage initializes. OpenCode bootstrap owns the rejection.
3. Plan the fix. Keep the public API. Filter only exact foreign table names in the existing bootstrap census. Preserve all existing migration branches. One delegate owns dependency patching; the lead owns runtime probes and the receipt.
4. Verify on the same surface. Passed on celld at the tested 256 MiB heap limit. Fresh composition, pre-existing application tables, unknown and partial schemas, current/pending/legacy-name migrations, and existing sessions after restart. The final fresh-volume run also passes every executed probe. Gate 0 remains incomplete for the unrun criteria.
5. Stage the commits so the failing repro lands before the fix in git history. Done. The failing runtime check is in 24c4e20. The patch will be a later commit.
6. Run Opening a PR. Skip external publication for this local feasibility experiment. Commit the evidence for review.

### Throughput checkpoint

The package patch and test fixture changes have separate file owners. Deployment is serial and controlled by the lead. Use the existing cerebro-slice project and persistent volumes, then a distinct project for fresh storage. The required outcome is the schema compatibility fix; remaining Session 0 criteria keep their own result states.

## Complete deterministic Session 0 checks

1. Ground. Trace OpenCode tool execution, replay, Agent scheduling, and celld alarms.
2. Sketch. Compare broker-owned asynchronous effects with a durable interval reconciler.
3. Agree. Proceed with the reconciler. No user design checkpoint was requested.
4. Implement. Add a separate recovery fixture DO, counted provider, and external crash runner.
5. Scrap. Revisit the design if the deployed SDK cannot preserve the required state.

### Design comparison

The independent review chose the interval reconciler. The plugin records one logical invocation and awaits its stored result. The Agent schedule controls approval-gated effects and recovery. The alternative placed the effect inside the plugin continuation, but that continuation disappears on restart and still needs durable recovery.

Keep one operation and one effect slot per recovery fixture DO. OpenCode call IDs identify attempts; the application operation ID and slot identify the effect. The argument digest includes the tool version. Reject changed arguments and stale approvals. Persist executing intent before dispatch and result before completion. Fence results by attempt ID. An ambiguous non-idempotent attempt becomes unknown-outcome.

OpenCode starts replay before registering SDK plugins. Static deny-all permissions limit that window. Runtime evidence must still establish that the broker registers and the interrupted loop recovers.

### Throughput checkpoint

One delegate owns the fixture provider and restricted effect Worker. A second owns recovery state and the Agent subclass. The lead owns routing, deployment, crash orchestration, and the receipt. All services and fault injection run serially in the existing isolated Compose project. No product paths change.

### Runtime findings during continuation

OpenCode registers plugins when the prompt activates a location. Waiting for plugin setup before prompt activation deadlocks. Start the prompt, then await bounded registration. Static permissions deny every tool except the fixture broker. Restart replay is tested through the real SDK.

OpenCode message listing defaults to descending order. Completion reads ascending messages and requires the latest assistant's terminal state plus the latest fixture tool's matching durable receipt. Old interrupted tool errors remain diagnostic data and cannot make a new continuation terminal.

The first idempotent crash check exceeded its 120-second observation deadline. Independent fixture timestamps later showed autonomous recovery after 182.56 seconds. Pinned celld source uses a 60-second waker tick and a 180-second elected waker lease. Retain the default runtime configuration and raise only the observer deadline to 300 seconds. Preserve the original failed deadline result.

The first MinIO outage check returned 500 because `getAgentByName` can fail before `stub.fetch`. The durability route now maps failures from both calls to 503 with an unknown outcome and retry guidance. Both outage checks subsequently passed.

Independent review replaced broad error substring matching with exact SDK denial messages. It also removed old tool errors from current-attempt terminal detection. The comment review removed one explanation by naming best-effort model interruption and returning its success state.

### Post-load heap failure investigation

Premise under test: raising the per-isolate heap from 128 MiB to 256 MiB is enough for the required repeated workload. The fresh run and ten-session baseline pass, but the subsequent full check fails eight probes. A fresh OpenCode control returns the exact V8 heap-limit materialization error. Do not increase the heap again before inspecting isolate placement and retained-cell behavior. The failure is preserved in evidence 29 and changes the final verdict unless a scoped fix is verified.

### Lifecycle correction and review

Raising the isolate heap to 256 MiB allowed cold probes but did not bound repeated use. A later main run failed eight checks after load. Evidence 29 preserves that failure. Idle eviction and a resident limit alone removed cells but left retiring isolates with SDK requests. Evidence 30 records the census. Evidence 31 records the passing functional run for that rejected partial fix.

Completed ordinary requests and terminal recovery operations now call OpenCode's supported close API. Ordinary requests serialize ownership of the client. Cleanup also closes the client if session initialization or storage sync fails. Active approval and effect work retain their runtime. The base experiment sets a 10-second idle eviction interval and a 16-cell resident limit, in addition to the 256 MiB heap limit. These are test settings, not a production capacity claim.

Independent review found that two route names could accept the same operation ID. The one-operation-per-object fixture now requires the route to match the operation ID. The broker check attempts that exact mismatch and confirms that no run was created.

The next fixed-version lifecycle check repeats the main probes and concurrent baseline twice. It observes the final census without deployment or restart. Seven short-lived requests after the main run are consistent with the seven recovery objects' 60-second AbortSignal timeout timers. The source explanation is not accepted in place of an observed drain.

The ordinary restart initially started celld and stopped storage together with `up --no-deps`. celld's startup bucket validation failed before MinIO became ready. The first verification attempt therefore failed with celld unavailable. The corrected sequence waits for PostgreSQL and both MinIO services before starting celld. README commands now encode that sequence. No data was deleted.

### Final deterministic verdict

The final Worker is `0b226a2f994ccfa9` in image `sha256:a2d9f8ab9dbc2be28b881d991c2e6b229d93d460b315f6d7a3b609dd42ad6cd9`. Five crash boundaries, both service outages, browser cookies, ordinary persistence, and all three migration cases pass. The two fixed-version workload rounds each pass 25 main checks plus both baselines. The idle census drains every cell request and retiring isolate in 77.984 seconds, with zero cell heap and no deployment or process change.

Gate 0 remains incomplete pending a real model provider and successful Worker PostgreSQL with trusted TLS. Private CA rejection is a recorded runtime limitation. No product changes or Session 1 work were started.
