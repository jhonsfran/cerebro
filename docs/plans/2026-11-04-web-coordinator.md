# Web coordinator support implementation plan

> For agentic workers: use subagent-driven-development to implement the reviewed units below. One owner writes application code and tests. The parent reviews, maintains this plan, and commits.

**Goal:** A person can start and control a durable agent team from web chat without Slack configuration or an account link. Results appear in the original web conversation.

**Architecture:** Use the existing canonical conversation address and owner for both entry points. New work uses version 2 internal envelopes without copied Slack routing. Exact legacy envelopes remain valid so saved tasks and receipt digests can resume. The existing private team cells, queues, permissions, role models, and shared identity limits remain the execution path. Public background state and a bound cancellation control stay separate from foreground activity.

**Tech stack:** TypeScript, Effect 4, Pi Durable 1.3.0, Agents 0.26.0, celld 0.6.1, React, PostgreSQL, and MinIO. No dependency upgrade.

## Completion checks

- A web conversation with the coordination profile receives `start_team`, `get_work`, `message_team`, and `stop_work` without Slack settings or links.
- The selected web agent is its coordinator. Published lead and worker definitions retain their separate models and grants.
- The original conversation receives one result after restart and replay. No public worker conversations or fake Slack records are created.
- Exact status, stop, and active-work updates do not call the coordinator model. Web and Slack share the same two-team identity cap.
- Web observation shows background work while foreground `busy` is false. The composer stays usable. `Stop background work` targets the displayed work ID, even after replacement work starts. Foreground Stop keeps its existing behavior.
- Current access, provenance, source ownership, deadlines, cancellation, role isolation, and strict payload limits remain enforced. Old durable Slack payloads retain their format and digests.
- Actual native recovery completes before a conversation reader. A visible browser send receives an asynchronous result and preserves it on reload.

## Throughput checkpoint

- **Blocking first steps.** Trace source ownership and authority. Compare two independent designs. Prove exact legacy decoding and payload order before writes.
- **Independent workstreams.** Read-only design and verification investigations run in parallel. One owner implements the coupled contracts, hosts, runtime, UI, and tests. Parent owns docs and commits.
- **Shared mutable state.** Keep separate private Team stores and the existing identity-wide admission ledger. Do not create a web-specific ledger or copy current Slack routing into new work.
- **Smallest safe decomposition.** Two reviewed commits. First make canonical source admission and delivery work for web. Then add public background controls, browser proof, full recovery checks, and docs. Each unit passes its focused gates before commit.

## Baseline

Start from clean commit `c07e994278e5301e853af9c883be06ff0021e949` on `codex/slack-coordinator-mvp`, already published in PR 19. The preceding complete run passed 137 runtime tests, 6 dependency tests, 117 channel tests, 33 contract tests, 19 fixture/operator tests, 13 type tasks, lint, and 7 native application checks.

The missing web behavior is source-proven. `createCoordinatorServices` and private Team admission require Slack. No additional baseline stack was started. Architecture and verification artifacts are in `/private/tmp/web-coordinator/`.

## Unit 1: Admit and deliver work by canonical conversation

Primary files are `packages/contracts/src/work.ts`, `apps/server/src/session/coordination.ts`, `apps/server/src/session/agent.ts`, `apps/server/src/team-agent.ts`, `packages/channels/src/team-reports.ts`, and the coordinator source, ledger, work, report, dispatch, team admission, state, and outbox modules in `packages/runtime/src/`.

- [x] Add current version 2 work and report envelopes. Retain exact original Slack schema declarations and field order in strict legacy branches. Preserve existing filters and branded IDs. New web and Slack work uses only the canonical source address.
- [x] Add literal legacy and version 2 contract cases before changing admission. Require malformed legacy values, unsupported versions, hybrids, and extra fields to fail. Compare exact legacy command JSON and digest values.
- [x] Audit every persisted task and input decoder. Use strict decoding at internal replay boundaries too:

  ```ts
  Schema.decodeUnknownSync(TeamCommandSchema, {
    onExcessProperty: "error",
  })(task.input);
  ```

- [x] Add one server-local source eligibility policy. Web needs a profile and a valid owned source row. Slack also needs its configured agent, workspace, and valid route. Validate old Slack tuples against the trusted source row after authentication.
- [x] Remove Slack thread from current `CoordinationServices` and `CoordinationBinding`. Keep complete source-address and owner checks, role pin resolution, identity-wide limits, and existing queue transports.
- [x] Preserve an old admission when sending its later commands or report. Reject admission/report format switches and legacy tuple mismatches. Do not rewrite task inputs, digests, work IDs, or retained documents.
- [x] Prove old-shaped pending dispatch and report replay with actual persisted Pi storage. Verify no reset, duplicate result, lost task, or changed digest.
- [x] Add a no-Slack native application case using published fixture role agents and normal web conversation/message APIs. Assert offered team tools, actual private role calls, one source result, no Slack records or calls, and no public role conversation rows.
- [x] Run contracts, focused native coordinator/team tests, channel regressions, types, and lint. Get fresh thermo and comment reviews, fix accepted findings, inspect the actual artifacts, then commit this unit.

Useful check commands run from the repository root:

```sh
rtk proxy pnpm test:contracts
rtk proxy pnpm test:channels
rtk proxy pnpm check-types
rtk proxy pnpm check
```

## Unit 2: Show and control background work in web chat

Primary files are `packages/contracts/src/session-service.ts`, coordinator work and conversation scope modules, a focused background-work component under `apps/web/src/features/product/`, and existing chat control composition. Tests extend contracts, native runtime, native application, and web behavior coverage.

- [ ] Add optional `activity.backgroundWork` derived from the current `SourceWork` pointer and its bound work document. Expose only work ID, status, and deadline. Do not read private Team transcripts or change foreground `busy`.
- [ ] Add the bound control on the existing endpoint:

  ```ts
  {
    kind: "stop-work",
    operationId,
    workId,
  }
  ```

- [ ] Authorize with the existing coordinate permission. Bind the operation ID to its structured target and cancel through the existing durable command transition. Reject another source's work and same-operation/different-target replay. Cancelling completed work A must not affect replacement work B.
- [ ] Show background status and an explicit `Stop background work` action while accepted or running. Use the existing mutation/error handling and stable operation IDs. Keep the composer available and foreground Stop unchanged.
- [ ] Test authorized snapshot observation after foreground completion, direct controls and updates, receipt confirmation, stale cancellation, access denial, duplicate reports, and mixed web/Slack caps.
- [ ] Extend the actual native application runner with no-Slack web completion, no-reader SIGKILL recovery, current-access report denial and authorized replay, and profile-absent ordinary chat. Observe the external model fixture and drained report queue before the first conversation read.
- [ ] Drive a fresh labelled browser stack. Send through the visible composer, observe the asynchronous result without reload, reload the same conversation, then send status and an update and click the explicit background stop action. Confirm separate foreground Stop still works. Retain screenshots, DOM, model traces, and persistence evidence. Clean only the owned stack.
- [ ] Update architecture and runtime setup docs for both entry points. Correct local profile preservation with an explicit Compose override `CEREBRO_MODEL: ""`. Preserve the original Slack plan as history.
- [ ] Run the full relevant gates and fresh thermo/comment reviews. Inspect results and fix accepted findings before the second commit.

Final gate commands include:

```sh
rtk proxy pnpm test:runtime
rtk proxy pnpm test:channels:native
rtk proxy pnpm test:contracts
rtk proxy pnpm test:channels
rtk proxy pnpm check-types
rtk proxy pnpm check
```

The runtime command also runs the six dependency checks. Native and browser checks use the real application stack with synthetic model and Slack endpoints. They do not send live Slack messages or paid model requests. No production deployment is part of this task.

## Final review and publication

- [ ] Audit new decision-log rows against this authorized run and actual artifacts with an independent reviewer.
- [ ] Confirm the working tree is clean and each unit has its own reviewed commit.
- [ ] Push the feature branch and update PR 19 around the final web and Slack behavior. Do not merge or deploy.
