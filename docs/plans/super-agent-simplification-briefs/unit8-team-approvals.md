# Unit 8: Teams run the agent's tools, with approvals in the coordinator conversation

Repository: /Users/jhonsfran/repos/cerebro, branch codex/persistent-super-agent at d7c8799. Do not commit; the lead reviews and commits.

## Why

A Team exists to act for the agent through its connectors. Today Team roles filter to read-only tools without approval, so a Team can read but never change anything. The coordinator stays coordination-only by the user's decision: it gets no connector tools. After this unit a Team role offers the agent's full enabled tool set; a tool that needs approval asks the person through the coordinator conversation; the person decides with the existing web Allow and Deny; the decision returns to the Team; the waiting tool continues or stops.

The grounding map with file and line pointers is /private/tmp/claude-501/-Users-jhonsfran-repos-cerebro/165aaed4-2f2f-4d95-9258-566ce91c53c8/scratchpad/unit8-grounding.md. Read it first and verify pointers before editing.

## Decisions

1. **Team tools.** Remove the read and no-approval filter in `packages/runtime/src/team-role.ts`; keep the internal-tool filter. In `apps/server/src/session/execution.ts`, stop filtering tools for Teams but keep the content bounding the `readOnly` flag also controls (`bounded` for the content layer and the combined receiving check). Rename the flag to what it now means. Update the "read-only" wording in `team-composition.ts`, `team-workers.ts`, and `coordinator-work.ts`.
2. **One approval store per Team cell.** `createTeamRuntime` creates one store with `createApprovalStore(storage, <team scope>)` and passes it to every role through `createConversationResources`' existing `stable.approvals` option, so one in-memory instance wakes any role's waiting tool. Native task IDs are unique within the Team's one harness, so approvals from different roles cannot collide.
3. **Team to coordinator: approval request.** When `pi-tools.ts` creates an approval (inside `api.commit`), call a new optional `PiToolConfiguration.onApprovalRequested(tx, approval)` in the same commit. The Team's implementation enqueues an approval-request outbox entry keyed by approval ID, modeled on the multi-slot pattern in `team-events.ts` (`TeamEventReceipts` plus a pending map and a retry task, cap 8, woken from `team-agent.ts` open and `onJob`). The wire is a new member of `TeamReportTransportSchema` in `packages/contracts/src/team-events.ts` with path `/team-approval`, carrying the work admission and the approval as a `ChatApproval`; extend `normalizeTeamReport` and `teamReportReceiptMatches`; add the path to `apps/server/src/session/proof.ts`. `consumeTeamReports` routes it by `delivery.path` unchanged. Keep the payload under the queue bound.
4. **Coordinator receives it.** Add a `/team-approval` route in `ConversationScope.handle` next to `/team-report`. Authorize coordinate, require the work source as `coordinator-report.ts` does, and in one `admissions.commit`: save a mirror record in a new Pi document family `TeamApprovals` keyed by approval ID (`{ key: WorkKey, approval: ChatApproval, digest }`, idempotent on digest, conflict on a changed payload), and `acceptIn` a new internal trigger with origin `{ kind: "teamapproval", key, approvalId }` whose text names the work, the tool, and says the person must Allow or Deny it in web chat. Copy the reply destination from the cause trigger as `teamTriggerIn` does, so a Slack-originated Team can tell its thread. Add the origin to `packages/contracts/src/triggers.ts` (actor internal, text limit 2000, trigger ID from `[kind, workId, approvalId]`), `TriggerEntryDataSchema`, `inputText`, `instruction-cause.ts`, `inspection-events.ts`, and `packages/contracts/src/inspection.ts`. Then drain.
5. **Snapshot.** Merge the mirror records into `ChatSnapshot.approvals` in `conversation-snapshot.ts`, with expiry computed from `expiresAt` as `approval-store.ts publicValue` does. Add optional `workId` to `ChatApproval` in `session-service.ts`. The mirror never enters the coordinator's own `cerebro_approval` store, so a Team approval never blocks the publication gate. `snapshotToolIds` keeps rechecking read authority for the mirrored tool IDs.
6. **Coordinator to Team: decision.** In `/decide`, when the approval ID is not in the local store, read the mirror, keep `runtime.authorize(context, "allow" | "deny")`, then relay synchronously with a signed Team fetch modeled on `readPrivateTeamInspection` in `apps/server/src/session/inspection-client.ts`: add `decideApproval(work, approvalId, decision)` to `CoordinationServices` (`coordinator-work.ts`), implement it in `apps/server/src/session/coordination.ts`, add a Team route `/approval-decision` in `packages/runtime/src/team-agent.ts` before command resolution, verified in `apps/server/src/team-agent.ts` the way inspection is, and add the path to `proof.ts`. The Team route opens the runtime if needed, calls `decide` on the shared store inside `pi.commit`, syncs storage, and returns `{ approvalId, state }`. The coordinator writes the returned state into the mirror and returns it as the `ChatDecisionReceipt`. A synchronous relay is chosen over a queued command because the web needs the real final state, the call is small and idempotent on the Team side, and a failed relay surfaces as `Unavailable` that the person can retry.
7. **Mirror reconciliation.** When the coordinator applies a Team report or a terminal notice for a work item, mark that work's still-pending mirror approvals `cancelled` in the same commit. A decision attempt always takes the Team's returned state as truth, so a tool that exited early is reconciled the next time anyone decides.
8. **Coordinator instructions.** Extend `profileInstructions` in `conversation-profile.ts` with one sentence: when a Team requests approval, tell the person to Allow or Deny it in web chat; the coordinator cannot decide it. The coordinator's own tool set stays coordination-only; do not register connector tools on it.
9. **Web.** `ApprovalRequest` in `apps/web/src/features/product/conversation-transcript.tsx` shows "Team <workId>" when `workId` is set; unassigned cards already render. Declare `workId` in the web approval schema.
10. **Deadlines.** The Team deadline caps the approval wait (provider `deadlineAt` bounds `window()` in `pi-tools.ts`). Document that an agent whose Teams need approvals should publish a longer `timeoutMs` budget.

## Tests

In-process where possible (`node --test`; the Team fixtures open Pi on node:sqlite):

- A Team role offers a write tool; calling it creates one approval in the Team store and one approval-request outbox entry.
- Delivering the request to the coordinator creates one mirror record and one `teamapproval` trigger; a duplicate delivery creates neither again; a changed payload conflicts. The coordinator snapshot lists the approval with its `workId`.
- Allow through the coordinator's `/decide` relays to the Team, the tool dispatches exactly once, and its result reaches the lead; a repeated Allow returns the same state with no second dispatch. Deny prevents dispatch and the tool returns a denial.
- A Team cell restart between request and decision: the decision still wakes the tool and it dispatches once.
- A Team that reaches its deadline or is cancelled with a pending approval: the mirror becomes `cancelled`; a later decision returns the Team's final state without dispatch.
- The coordinator publication gate does not wait on a mirrored Team approval.
- Audit: an approved Team write emits `tool.dispatched` then `tool.settled` with its approval ID; a denied call emits `tool.settled` with outcome denied. Use a recording audit stub.
- `tests/runtime/team-runtime.test.ts` and `tests/runtime/fixture-team.ts`: the journey that asserted no `team_write` and zero approvals moves to the new contract; add one Docker journey for request, Allow, and dispatch through the real Team cell if the fixtures support it.
- Contracts: the new transport member, the new trigger origin, and `ChatApproval.workId`.
- Channels: the web transcript renders a Team approval card with its label and Allow and Deny post to the coordinator conversation.

## Docs

`docs/architecture/slack-coordinator.md` (roles table and the approval paragraph), `docs/operations/agent-teams.md` (remove "out of scope"; describe Team approvals in web chat and the deadline budget), `docs/architecture/overview.md` (Teams use the agent's tools; approvals route to the coordinator).

## Standards

- Read /Users/jhonsfran/repos/cerebro/.claude/CLAUDE.md and follow it. Run `pnpm check`; `pnpm fix` is allowed for formatting.
- No narrating comments; keep a comment only for a non-obvious why.
- Contracts first, then let `pnpm check-types` walk you through runtime, server, web, tests, docs.

## Done when

1. `pnpm check-types`, `pnpm check`, `pnpm test:contracts` pass.
2. The tests above exist and pass under `node --test` on every runtime file you changed or added; the channel UI tests pass under `bun test` on the files you changed.
3. `rtk proxy grep -rn 'effect === "read"' packages/runtime/src/team-role.ts apps/server/src/session/execution.ts` reports nothing.

Do not run `pnpm test:channels`, `pnpm test:runtime`, or `pnpm test:integration`; the lead runs them. Report the exact commands with results, every file changed outside this brief and why, and anything in the brief that was wrong.
