# Grounding: Team approvals (map at commit d7c8799)

Paths are under /Users/jhonsfran/repos/cerebro. Verify each pointer before editing.

## Approval machinery

- packages/runtime/src/approval-store.ts: 11-29 `permitSchema` (actorPrincipalId, agentId, approverId, argumentDigest, connectorFingerprint, connectorId, delegationId?, effect, expiresAt, id, operationId, organizationId, policyVersion, principalId, runId, toolId, toolVersion). 88-90 table `cerebro_approval` (approval_id primary key across the Durable Object; session_id, task_id, call_id, arguments, permit, state). 59-74 `publicValue` maps a row to ChatApproval; pending past expiresAt reads "expired". 77-80 store scoped by `(storage, sessionId)`; 81-87 in-memory waiter map per instance. 106 `hasPending`, 113 `all`, 121 `cancel`. 129-149 `decide` (same decision twice idempotent; otherwise Conflict "already-final"; `notify("decided")` at 147). 151-155 `nextChange`. 173-200 `request` (INSERT OR IGNORE; rechecks digest, task, call). 201-221 `requireAllowed`. 222-226 `revalidate`.
- packages/runtime/src/pi-tools.ts: 52-77 `PiToolConfiguration`; 80 `APPROVAL_TTL_MS` 30 min; 119-142 `awaitDecision`; 173-181 operationId `[orgId, sessionId, taskId, callId]`, approval ID `approval:<operationId>` (307). Sequence: 259 authority; 261-265 dependencies; 266-282 memos; 294 approval required when effect write or requiresApproval; 295-316 candidate; 317-327 `api.commit(approvals.request)`; 329 persist; 344-361 wait until expiresAt or abort; 362-386 recheck authority and `boundApprovalMatches`; 394-398 recheck dependencies; 399-421 audit `tool.dispatched`; 422-437 dispatch memo and execute; 440-452 post-call authority (write becomes UnknownOutcome); 453-460 outcome memo; 203-230 and 465-473 `tool.settled`; 499-506 `finally` cancels a pending approval on any exit.
- packages/runtime/src/conversation-resources.ts: 51-59 uses `stable.approvals` or creates a store with the conversation sessionId; 29-45 allow and deny map to the approve action; 60-115 `authorize`; 195-215 `createPiTools`; 217-224 returns `approvals`.
- Contracts: packages/contracts/src/session-service.ts 75-91 `ChatApproval` (approvalId, arguments, callId, expiresAt, operationId, state, taskId, toolId), 93-97 `ChatDecisionReceipt`, 177-187 `ChatSnapshot.approvals`, 214-217 `ChatDecisionRequest`, 227-229 `ChatClient.decide`. packages/contracts/src/tools.ts 140-199 `Approval` and `approvalMatches`. packages/contracts/src/tool-service.ts 23-60 `connectorFingerprint`, `BoundApproval`, `boundApprovalMatches`.

## Decision path today

- packages/api/src/routers/product.ts 152-171 `POST /product/conversations/{conversationId}/approvals/{approvalId}`; packages/channels/src/conversations.ts 210-231 `approveAs` and `approve` (requireConversation "approve", then `sessions.decide`).
- apps/server/src/session/client.ts 31-37 paths, 116-140 signed fetch to SESSION `[org, owner]`, 173-177 `decide` posts `/decide`.
- packages/runtime/src/conversation-scope.ts 89-92 `decisionSchema`; 771-797 `/decide` (authorize allow or deny, `pi.commit(guardIn; approvals.decide)`, storage.sync, returns receipt; unknown ID is NotFound); 811-813 Denied triggers `revalidate`; 500 a pending approval blocks the publication gate; 707-733 `/team-report` and `/team-event-return` routes.
- Snapshot: packages/runtime/src/conversation-snapshot.ts 27 `approvals.all()`, 66-71; packages/runtime/src/pi-harness.ts 42-52 `snapshotToolIds`, 429-439; conversation-scope.ts 633-638 read authorization with those tool IDs.
- Web: apps/web/src/features/product/chat-connection.ts 129-138 `decideApproval`; types.ts 127-130 receipt schema; conversation.tsx 338-340; conversation-transcript.tsx 98-157 `ApprovalRequest`, 208-241 `placeApprovals`, 350-357 unassigned cards.

## Team cell

- packages/runtime/src/team-role.ts 119-123 `createConversationResources(configured, storage, metadata)` without `stable`, so each role creates its own store in the Team Durable Object; 90-97 the read-only filter; 100 provider deadline equals the work deadline; 109-117 `checkDependencies` first checks the Team is running; 160-163 exposes `resources.approvals`.
- packages/runtime/src/team-runtime.ts 75 lead, 76-90 worker map, 362 returns `{ lead, worker }`; 195-343 `receive`.
- packages/runtime/src/team-content.ts 16-25 `teamRoleAddress` (`team:<digest{key,role}>`).
- apps/server/src/team-agent.ts 183-210 `configure` calls `createExecutionComposition(..., readOnly = true)` at 206; 135-181 `resolve` accepts only `/control`, verifies the proof, requires actor equals owner.
- apps/server/src/session/execution.ts 61-72 `ownerContext` is the owner as a human principal; 113-171 `checkSession`; `readOnly` controls (a) 446-451 tool filter, (b) 181 `bounded` content layer, (c) 349-353 combined receiving check.
- packages/runtime/src/team-composition.ts 8-11 overlay says read-only; 27-38 role projection.
- packages/runtime/src/team-agent.ts 321-389 `onRequest` (`/inspect` first, then resolve and `runtime.receive`); 391-419 `onJob`; 150-151 wake on open; 225-262 outbox and events.

## Transports

- apps/server/src/bindings.ts 21-25 TEAM_COMMANDS, TEAM_REPORTS, SESSION, TEAM, AUDIT_SINK; apps/server/src/index.ts 74-83 queue routing; deploy/queues.mjs and deploy/bootstrap.mjs queue config.
- Commands: apps/server/src/session/coordination.ts 28-31 `sendCommand`; packages/runtime/src/coordinator-dispatch.ts 100-178; coordinator-commands.ts 35-86; coordinator-work.ts 74-80 `CoordinationServices`; apps/server/src/team-events.ts 26-83 `consumeTeamCommands`.
- packages/contracts/src/work.ts 146-164 `TeamCommandSchema` (start, input, cancel), 212-223 `TeamReportDeliverySchema`, 231-250 receipts, 252-258 `workCellName`.
- packages/contracts/src/team-events.ts 19-24 `TeamEventCommandSchema` uses `TeamCommandSchema.members[1]` by position; 25-28 `TeamCommandTransportSchema`; 33-40 `normalizeTeamCommand`; 41-48 `TeamEventReturnSchema`; 54-57 `TeamReportTransportSchema`; 59-78 `normalizeTeamReport` maps kind to path; 79-100 `teamReportReceiptMatches`.
- Returns: packages/runtime/src/team-report-outbox.ts (single slot); packages/runtime/src/team-events.ts is the multi-slot pattern (65-79 receipts and pending map, 125-215 retry task, 220-283 `returnIn`, cap 8 at 259-264); apps/server/src/team-agent.ts 116-134 `TEAM_REPORTS.send`; apps/server/src/team-reports.ts 22-78 `consumeTeamReports` signs `delivery.path` and fetches SESSION.
- Identity side: conversation-scope.ts 707-733; packages/runtime/src/coordinator-report.ts 80-239 (authorize coordinate at 136, `admissions.commit` 168-221, `acceptIn(reportTriggerIn)` 209-212, drain 231); packages/runtime/src/triggers.ts 548-601 `receiveReturn`.
- apps/server/src/session/proof.ts 48-59 path enum (add new paths here); 85-151 authenticate and sign.
- Synchronous signed Team fetch precedent: apps/server/src/session/inspection-client.ts 116-160 `readPrivateTeamInspection`; apps/server/src/session/team-inspection.ts 23-70 verification.

## Team triggers

- packages/contracts/src/triggers.ts 46-56 origins `teamreport` and `teamnotice`; 62-78 actor and text-limit maps; 103-131 `TriggerSchema`; 156-158 teamnotice ID `[kind, workId, reason]`; 181-192 admission rejects internal origins; 212-222 `TriggerEntryDataSchema`; 265-268 `inputText` framing for internal events.
- packages/runtime/src/coordinator-event-content.ts 20-37 `causeReplyIn`; 38-55 `teamTriggerIn`; 56-80 `reportTriggerIn`; 82-96 `terminalNoticeIn`.
- packages/runtime/src/triggers.ts 338-380 `acceptIn`; 759-782 delivery authorize.
- Channel lists elsewhere: packages/runtime/src/instruction-cause.ts 125-127; packages/runtime/src/inspection-events.ts 45-46; packages/contracts/src/inspection.ts 205-213.

## Audit

- packages/contracts/src/audit.ts 19-59 facts, dispatched and settled payloads with `approvalId`, `ToolAuditEvent`; no decision event.
- packages/runtime/src/audit-sink.ts 6-25; apps/server/src/audit-sink.ts 24-51; packages/db/src/repositories/audit.ts 26-61 idempotent by event ID.
- Team roles already pass the real audit sink (execution.ts 403). Test fixtures stub it: tests/runtime/fixture-team.ts 395, tests/runtime/team-provenance-fixture.ts 292.

## Inspector

- No approvals field in Team or coordinator inspection. packages/runtime/src/team-inspection.ts 82-196; packages/contracts/src/inspection.ts 104-145, 271-312; packages/runtime/src/conversation-inspection.ts 73-126.

## Tests

- Approval coverage today: contracts (tests/contracts/contracts.test.ts 134, 240, 268; session-contracts.test.ts 211, 270), fake-session channels (tests/channels/web.test.ts 181, 315, 373; conversation.test.ts 470, 739; ui.test.ts 473; observation.test.ts 108), policy (tests/policy/tool-boundary.test.ts 300; catalog-authority.test.ts 315).
- tests/runtime/team-runtime.test.ts 132-164 asserts no `team_write` and zero approvals, counted in tests/runtime/fixture-team.ts 599-604; the write tool is defined at 151-160 and 512-516.
- Transport tests to extend: tests/channels/team-reports.test.ts 107; team-events.test.ts 156, 202, 240; tests/runtime/team-report-outbox.test.ts 34.
- Deleted journeys at fe6d4db: `git show fe6d4db:tests/runtime/approval-journey.test.ts` and `fe6d4db:tests/runtime/audit-journey.test.ts` show the earlier conversation-level assertions worth porting to Teams.
