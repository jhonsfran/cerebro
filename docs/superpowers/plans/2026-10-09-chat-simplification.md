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

- [x] The receipt cursor reads `max(cursor)` instead of every channel item.
- [ ] Dropping the pre-submit `inspect` was tried and reverted. The pilot revocation gate requires a message from a viewer who lost access to cited content to be denied before an inbox row exists, and the inspect is what denies it there.

Files: `packages/channels/src/service.ts`.

## Verification record

| Cut | Commit checks |
| --- | --- |
| Baseline | Full type check. 114 AG-UI and browser tests. |
| 1 | Type check on runtime, channels and AG-UI. 6 delivery tests. 114 AG-UI and browser tests. 53 channel tests. In-memory runtime tests green. |
| 2 | Full type check including the web build. 35 browser, panel and observation tests. 6 delivery integration tests. Lint on every changed file. |
| 4 | 84 in-memory runtime tests. Type check. Lint. |
| 5 | 61 channel tests. Type check. Lint. The inspect removal failed the pilot revocation gate and was reverted. |

Three Docker recovery fixtures in `tests/runtime/recovery.test.ts` fail before any cut. The first was run on the baseline commit and failed there; the other two use the same reader and failed the same way on cut 1. The reader looked for celld state under `/var/lib/celld/state`, which this compose file's bucket durability does not use. The reader now also scans `/tmp/celld-*` and the fixture read retries a refused port, which makes the first of the three pass. The other two expect local state before any read after a restart, which bucket durability does not provide. They remain open and are not part of this change.

Final head checks, all on the merged commit unless noted:

| Check | Result |
| --- | --- |
| `pnpm check-types`, `pnpm build` | Green |
| `pnpm check` | 153 findings, identical to the baseline set; zero new |
| `pnpm test:contracts`, `test:identity`, `test:policy`, `test:memory` | Green |
| `pnpm test:runtime` | 99 tests, 97 pass; the 2 failures are the recovery fixtures above |
| `pnpm test:channels` | 61 pass |
| `pnpm test:integration` | 44 tests, 40 pass on the first run. The backup test failed on exhausted Docker network pools and passed alone after cleanup. Two pilot gates failed on the removed pre-submit inspect and pass since it was restored. The unknown-outcome gate failed on the baseline commit too; after the two fixes below the full pilot passes 10 of 10. |
| `pnpm test:chat` | Green on the clean head before the cut 5 rebuild: early text, partial restore on reattach, sign-out denial in 1.8 s |

The pilot gate "unknown non-idempotent receipt never replays and authorized reconciliation uses read-only proof" failed on the baseline commit and every cut, always with one extra model request after reconciliation. Bisected to `3176c2b`. The request was a second run started by the channel dispatcher: the gate's follow-up message is rejected with 409 while the effect is uncertain, its `channel_inbox` row stayed `pending`, and the drain resubmitted it after reconciliation. `submitInbox` now deletes a row the session rejected with 409 on the synchronous path; the drain keeps retrying its own rows. The regression test is in `tests/channels/web.test.ts`.

That resubmission had also been hiding a second defect. A run that hits an uncertain tool ends in Pi at the terminate control before reconciliation, so reconciling changes only Cerebro state and Pi emits no further event. The coordinator ran the canonical projection once from a forked observe attachment, and when that pass failed transiently nothing recorded it: Effect 4 swallows a failing `Stream.callback` registration, so the stream neither ended nor failed. The run stayed running and the repair job only waited. Reconcile now projects directly, the repair job runs a projection pass each loop, and a failed attachment fails the observe stream. The engine contract gained `project()`. The regression test is in `tests/runtime/pi-session.test.ts`.

The audit gate was separately flaky: it counted every audit row of the organization twice while earlier conversations still drained their outboxes, and one late row failed it in three of thirteen runs. It now re-reads the export and the count until they agree and checks replay on one event.
