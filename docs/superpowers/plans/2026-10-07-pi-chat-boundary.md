# Pi chat boundary implementation plan

> For agentic workers: implement these tasks in sequence and review behavior and code quality before completion.

Goal: keep Pi execution inside the Durable Object and make TanStack own the browser transcript.

Architecture: keep the authenticated Hono API as a proxy. Map events in the Durable Object's server adapter and deliver AG-UI chunks through an observation-only connection. Reconnect restores an authorized snapshot without submitting work.

Tech stack: Pi Durable 1.0.4, Agents SDK 0.26.0, Effect 4.0.1, TanStack AI 0.65.0, React, celld.

## Task 1. Native event content and snapshot recovery

- [x] Extend the Pi projection to emit visible thinking deltas and retain current provisional content for new attachments. Preserve private provider metadata and canonical product history ownership.
- [x] Extend the authoritative observation schema only where transient content is needed. Keep transient updates on the current revision and remove them after canonical completion.
- [x] Verify text/thinking snapshots and append behavior with native-shaped Pi events, including a mid-run attachment and a tool step.

Files: `packages/runtime/src/pi-provisional-text.ts`, `pi-harness.ts`, `celld-session-store.ts`, `packages/contracts/src/session-service.ts`, and the corresponding runtime tests.

## Task 2. Server protocol boundary

- [x] Move protocol projection into the deployed Durable Object adapter. Keep internal domain observations available to the existing SessionService consumers.
- [x] Forward mapped chunks through the authenticated product endpoint. Preserve generation/address checks and immediate denial. The proxy must not call Pi prompt or start another loop.
- [x] Emit snapshot, text, reasoning, tool, and run events with stable identities. Keep the observation attachment open across run terminal events.
- [x] Verify that unauthorized direct access fails and attachments submit zero model requests.

Files: `apps/server/src/deployed-session-agent.ts`, `session-transport.ts`, `channel-services.ts`, `packages/api/src/routers/observations.ts`, `packages/channels/src/types.ts`, and `packages/ag-ui/src/protocol.ts` and `authorized-observation.ts`.

## Task 3. TanStack message ownership

- [x] Consume mapped server chunks with TanStack's supported connection. Use its message state as the transcript source and remove browser-side protocol projection.
- [x] Render typed thinking and tool parts. Keep Cerebro controls for approvals, citations, and durable Stop. Preserve pending command identities, generation fencing, and stale attachment cleanup.
- [x] Verify a partial answer, reconnect, canonical replacement, tool results, denial, and zero submissions from hydration.

Files: `packages/ag-ui/src/client.ts` and `projection.ts`, `apps/web/src/features/product/chat-connection.ts`, `conversation.tsx`, and `chat.ts`, `tests/ag-ui/adapter.test.ts`, and `tests/channels/ui.test.ts`.

## Task 4. Integrated verification

- [x] Run `rtk proxy bun test tests/ag-ui/adapter.test.ts tests/ag-ui/authorized-observation.test.ts tests/channels/ui.test.ts`.
- [x] Run relevant native text/transport tests and `rtk proxy pnpm exec turbo run check-types --force`.
- [x] Run Ultracite fix and check on changed TypeScript files. Review the final diff against the initial dirty working tree.
- [x] Record verification results and any live runtime checks that were not run. Do not claim exact replay, production latency improvement, or crash qualification from unit tests.

## Verification record

- 117 targeted AG-UI, frame-limit, browser connection and rendered conversation tests passed.
- 77 native Pi/runtime tests passed, including atomic snapshot capture and text/thinking overflow at observer capacities 1 and 2.
- 2 private transport credential tests passed.
- Full repository type checks passed: 14 tasks, including the web production build.
- Scoped Ultracite check passed on all 25 changed TypeScript files. `git diff --check` passed.
- Independent spec and code-quality reviews approved the final implementation.
- Final disposable application fixture `cerebro-s1-chat-8f002d8a` passed both domain and AG-UI delivery, partial reconnect, canonical history, observation after `RUN_FINISHED`, duplicate submission and committed sign-out denial. Observation and reconnect did not create additional model requests. Evidence: `artifacts/slice-1/3176c2b16d748d68856ccde64cd1a75300a6070a/cerebro-s1-chat-8f002d8a/chat.json`.

The fixture ran from a dirty working tree on base `3176c2b16d748d68856ccde64cd1a75300a6070a`. It used a deterministic provider with 1,500 ms between tokens to keep the partial-reconnect window open. It is functional evidence, not a latency measurement or clean-commit qualification.

An earlier final-wire fixture, `cerebro-s1-chat-ae9a82a2`, failed with a terminated HTTP body. Its stream failure coincided with a 539 ms access check, past the existing 500 ms authorization timeout. The failure log remains in that fixture's artifact directory. This is evidence of remaining access-read cost; a later passing run does not establish that the latency problem is resolved. All disposable containers and volumes created by these checks were removed after evidence capture.

The private wire now contains `{ events }`; its first custom event supplies the observation used for authorization. Limits remain bounded: 1 MiB domain observation, 4 MiB mapped event and 8 MiB private batch. Large history, JSON escaping and UTF-8 overflow have regression coverage.

Exact cursor replay, paid-provider latency and new crash qualification for the AG-UI path were not run. Existing native recovery changes were preserved; their owner committed them into the shared base while this refactor was in progress. No commit, push or deployment was made for this refactor.
