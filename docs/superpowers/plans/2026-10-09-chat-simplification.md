# Chat simplification plan

> For agentic workers: each cut is one commit with its own verification. Do not merge cuts.

Goal: make the chat usable by removing the layers between Pi and the browser, without moving authority, approvals or tool receipts out of Cerebro.

Design: [chat simplification design](../specs/2026-10-09-chat-simplification-design.md). Decision trail: [chat-simplification-decisions.tsv](../../implementation/chat-simplification-decisions.tsv).

## Cut 1. Authorize per attachment and interval

- [x] API delivery checks access on attach and every 2 seconds instead of on every frame and every 250 ms.
- [x] `chatAccess` authorizes the agent once and each distinct content dependency once instead of twice per channel item.
- [x] The session store authorizes the snapshot on attach, on resnapshot and once per interval. Committed records keep their own check. Provisional text rides on the interval.
- [x] Live denial bound relaxed from 1 second to 3 seconds.

Files: `packages/channels/src/service.ts`, `packages/runtime/src/celld-session-store.ts`, `tests/live/chat-stream.test.ts`.

## Cut 2. One wire, one browser loop

- [x] The Durable Object emits domain NDJSON only. The AG-UI batch route is removed.
- [x] The API forwards session bytes and appends its own `access-denied` frame on revocation.
- [x] The browser reads frames in one loop, checks epoch and sequence, applies them to the projection and renders from `projectionMessages`.
- [x] `packages/ag-ui`, `@tanstack/ai`, `@tanstack/ai-client`, `@tanstack/ai-react` and `@ag-ui/core` are removed.

Files: `apps/web/src/features/product/observation.ts`, `projection.ts`, `chat-connection.ts`, `packages/api/src/observation-delivery.ts`, `packages/api/src/routers/observations.ts`, `apps/server/src/deployed-session-agent.ts`, `apps/server/src/session-transport.ts`.

## Cut 3. Forward bytes

Folded into cut 2. The API no longer decodes or re-encodes frames.

## Cut 4. Project canonical state on state events only

- [x] The Pi adapter re-runs the canonical projection only for batches that contain a submission, run, tool, task or snapshot event. Text and thinking deltas emit provisional updates only.
- [x] Execution membership for the active inputs is cached until the active inputs change.

Files: `packages/runtime/src/pi-harness.ts`.

## Cut 5. Shorter web submission

- [x] The web submit path no longer calls `inspect` before `submit`. The Durable Object authorizes the submission.
- [x] The receipt cursor reads `max(cursor)` instead of every channel item.

Files: `packages/channels/src/service.ts`.

## Verification record

| Cut | Commit checks |
| --- | --- |
| Baseline | Full type check. 114 AG-UI and browser tests. |
| 1 | Type check on runtime, channels and AG-UI. 6 delivery tests. 114 AG-UI and browser tests. 53 channel tests. In-memory runtime tests green. |
| 2 | Full type check including the web build. 35 browser, panel and observation tests. 6 delivery integration tests. Lint on every changed file. |
| 4 | 84 in-memory runtime tests. Type check. Lint. |
| 5 | 61 channel tests. Type check. Lint. |

Three Docker recovery fixtures in `tests/runtime/recovery.test.ts` fail identically on the baseline commit. Their reader looked for celld state under `/var/lib/celld/state`, which this compose file's bucket durability does not use. The reader now also scans `/tmp/celld-*` and the fixture read retries a refused port, which makes the first of the three pass. The other two expect local state before any read after a restart, which bucket durability does not provide. They remain open and are not part of this change.

The final-head checks are recorded in the decision trail.
