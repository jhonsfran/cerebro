# Pi-native runtime implementation plan

> For agentic workers: Use the approved Pi-native design. Give each file one implementation owner. Review the complete diff and verify the actual Docker-hosted application.

**Goal:** Pi Durable owns agent execution. Cerebro owns company configuration, permissions, tools, approvals, and chat presentation.

**Architecture:** Keep the official PiHarness and Lifecycle integration on celld. Derive chat snapshots from Pi's native view without saving another transcript, run state, or answer history. Persist only company metadata, content access dependencies, approval decisions, and channel delivery records.

**Tech stack:** TypeScript, Pi Durable, Agents PiHarness, celld, PostgreSQL, Hono, oRPC, React, Docker Compose.

## Completion gate

- Send returns a native receipt and produces a visible assistant answer.
- Retrying an operation ID does not add another input.
- Stop uses Pi's native abort behavior.
- Reconnect gets the current native transcript and partial output.
- Accepted work resumes after SIGKILL with no observer attached.
- Pending approvals survive restart. Denial and revoked authority prevent a write.
- An interrupted at-most-once tool never dispatches a second external effect.
- The runtime has no Cerebro execution store, durable output projection, handoff repair, or projection repair job.
- Type checks, lint, retained contract and policy checks, and the new runtime and chat tests pass.

## Throughput checkpoint

- Blocking first steps: Confirm native snapshot, submission, Stop, lifecycle, and application-document APIs. Confirm Docker access before runtime verification.
- Independent workstreams: Runtime and contracts have one owner. API and channel integration has a second owner. Web chat and UI tests have a third owner. The lead owns verification drivers and documentation.
- Shared mutable state: Publish the contract before consumers change. Each source file has one writer. Run workspace formatting after implementation writers finish.
- Smallest safe decomposition: One coordinated migration with three disjoint source areas. Do not keep two runtime implementations after the callers migrate.

## Task 1: Native host and company metadata

Owner: runtime_owner.

- [x] Replace the execution coordinator and snapshot store with native Pi operations.
- [x] Save owner and agent configuration metadata independently of execution state.
- [x] Derive ChatSnapshot from native entries, live tools, and company approval documents.
- [x] Keep current model and tool authorization, exact-call approval binding, and durable dispatch/outcome memos.
- [x] Delete the execution projection, handoff contracts, and repair jobs.
- [x] Adapt the isolated runtime fixture to the new host.
- [x] Run `rtk proxy pnpm --filter @cerebro/runtime check-types`.

## Task 2: API and channels

Owner: api_owner.

- [x] Replace SessionService with the direct Promise-based chat transport.
- [x] Expose messages, Stop, approval decisions, snapshot reads, and observations.
- [x] Preserve authentication, current company policy, and private conversation ownership.
- [x] Keep agent setup and access configuration functional.
- [x] Remove run-specific product routes and retired execution-state reads.
- [x] Run affected package type checks.

## Task 3: Small chat

Owner: web_owner.

- [x] Render native message IDs and ordering from complete ChatSnapshot frames.
- [x] Keep Send, Stop, approval decisions, reconnect, and sign-out content clearing.
- [x] Keep one operation ID for each pending send retry.
- [x] Remove steer/replace controls, run cards, and execution membership reducers.
- [x] Replace UI protocol tests with the new chat behavior.
- [x] Run focused chat tests and web type checks.

## Task 4: Runtime proof

Owner: lead, then independent verification reviewer.

- [x] Exercise Send, duplicate retry, partial output, detach, and reconnect.
- [x] Exercise native Stop while the fake model is active.
- [x] Kill celld during active work and pending approval. Verify recovery without an observer.
- [x] Kill celld after a remote effect but before its response. Verify one dispatch.
- [x] Verify denied approval, wrong owner, and revoked authority.
- [x] Replace tests for removed execution requirements. Preserve independent tool and authorization checks.
- [x] Run the Docker-hosted application and drive the chat through the browser.

## Task 5: Final checks and documentation

- [x] Update the architecture overview and ADR to the implemented ownership model.
- [x] Run `rtk proxy pnpm fix` and lint on changed files, run workspace `rtk proxy pnpm check-types`, and report existing workspace lint failures.
- [x] Run retained contracts, policy tests, and new runtime/chat verification.
- [x] Search production sources for the removed execution store and repair symbols.
- [x] Review the complete diff and record verification evidence in `.audit/pi-native-runtime.tsv`.

## Shared contract

ChatSnapshot contains address, agentVersion, busy, messages, and approvals. Messages use native entry IDs, role, text, optional thinking, and complete/streaming state. Approvals use native task and call IDs plus the exact tool intent and immutable decision.

ChatClient has send, stop, read, decide, and observe methods. Send returns Pi's operationId, session, and accepted receipt. Decide returns only approvalId and state so Deny remains safe after source revocation. Observe returns NDJSON snapshot or access-denied frames. There is no domain revision, epoch, sequence, copied run, or canonical output protocol.

## Accepted behavior changes

Pi owns busy-input queuing, operation-ID deduplication, Stop, transcript ordering, and recovery. Reconnect reads current Pi state. The UI has no independent run-specific cancellation or immutable joined-answer contract.

## Verified result

Pi Durable is the execution authority. The native Docker journeys pass for Send, concurrent retry, Stop, reconnect, recovery with no observer, pending approval recovery, and an interrupted at-most-once write. Current source revocation preserves safe Stop and Deny, blocks Allow and reads, and prevents dispatch after an approval decision.

The actual deployed Worker bundle is `740805201006cf01`, with SHA-256 `2c7d5edf5427686ddeb939f1b48f0bf9784254fdff6cd21723c40504e6017e81`. The application pilot passes 9 tests, the live chat journey passes, and the browser confirms Send after Stop and reconnect. Independent review found no remaining defect.

Workspace type checks and lint on changed files pass. Full workspace lint still reports errors in 29 untouched files, plus existing formatting issues in UI and skill files. The decision trail is `.audit/pi-native-runtime.tsv`.
