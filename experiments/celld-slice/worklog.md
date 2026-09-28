# Session 0 work log

## Prototype checklist

1. Scope the decision the prototype exists to make: which layout, which interaction, which density, or for an empirical fork which behavior, timing, or approach. No decision means no prototype. Route to Feature.
   Decision: can celld 0.6.0 run and recover the specified stack?
2. Gather references when the design space is open. Search for prior art, summarize a moodboard of themes, palettes, and layouts, let the user pick directions before building. Skip when the direction is set.
   Skip visual references. Use the pinned celld example and runtime source.
3. Build throwaway in an isolated scratch dir, separate from production source. For a visual decision, vanilla HTML/CSS/JS or the lightest stack that renders the idea, CDN deps, a dev server with hot reload. For a behavioral or timing decision, the smallest script that exercises the question. No production framework, no tests, no abstractions.
   Use experiments/celld-slice. The requested runtime checks override the generic no-tests suggestion.
4. When comparing alternatives, build them behind one switcher (buttons or a keypress), each variant labeled. This is the **exhaust-the-design-space** principle skill made cheap.
   Compare PostgreSQL transports with named probe results if the first fails.
5. Verify on the matching surface. For a visual decision, screenshot each variant via the control skill and drive the interaction. For a behavioral or timing decision, observe the thing you are deciding by logging the timing, printing the output, or watching the render. The observation is the test here, not an assertion.
   Exercise the deployed Worker through celld ingress.
6. Present alternatives, tradeoffs, and a recommendation. The output is the decision plus the throwaway artifact, not shippable code. Hand the chosen direction to **Feature** (or `architect` for the shape) for the real build.
   Record the runtime verdict in docs/implementation/session-0.md.

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

1. Reproduce it yourself on the matching surface via the control skill (Non-negotiables).
   Done. Evidence 06 records the real celld failure on new volumes.
2. Binary-search the cause.
   Done. Agent tables fail; empty application storage initializes. OpenCode bootstrap owns the rejection.
3. Plan the fix.
   Keep the public API. Filter only exact foreign table names in the existing bootstrap census. Preserve all existing migration branches. One delegate owns dependency patching; the lead owns runtime probes and the receipt.
4. Verify on the same surface.
   Passed on celld at the tested 256 MiB heap limit. Fresh composition, pre-existing application tables, unknown and partial schemas, current/pending/legacy-name migrations, and existing sessions after restart. The final fresh-volume run also passes every executed probe. Gate 0 remains incomplete for the unrun criteria.
5. Stage the commits so the failing repro lands before the fix in git history.
   Done. The failing runtime check is in 24c4e20. The patch will be a later commit.
6. Run Opening a PR.
   Skip external publication for this local feasibility experiment. Commit the evidence for review.

### Throughput checkpoint

The package patch and test fixture changes have separate file owners. Deployment is serial and controlled by the lead. Use the existing cerebro-slice project and persistent volumes, then a distinct project for fresh storage. The required outcome is the schema compatibility fix; remaining Session 0 criteria keep their own result states.
