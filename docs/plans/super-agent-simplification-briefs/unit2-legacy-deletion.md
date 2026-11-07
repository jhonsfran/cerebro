# Unit 2: delete pre-cutover paths

Repository: /Users/jhonsfran/repos/cerebro, branch codex/persistent-super-agent. Unit 1 (fork removal) has already landed on the branch you start from. Do not commit; the lead reviews and commits.

## Why

Every conversation is now the agent's primary conversation. Everything that existed to keep pre-cutover conversations readable, replayable, or routable is dead weight: legacy input paths, legacy Slack decisions, legacy timer origins, legacy receipt codecs, the source cutover state machine, the policy-version split, Slack-kind conversation rows and their notifier, the foreground subagent and history-search tools that only policy version 0 registered, and the older identity-runtime retirement scripts. Assumption for this branch: no installation holds pre-cutover data. Delete, do not migrate. Durable document schemas that change get a version bump whose `migrate` throws for older versions, matching how other documents in `packages/runtime/src` reject unknown versions.

Line numbers below come from an inventory taken before Unit 1 landed. Verify each pointer against the current file.

## Decisions already made

1. Forks are gone, so the source admission state machine goes entirely: `packages/runtime/src/source-admission.ts`, the `cerebro-source-cutover` job, `requireFreshSourceIn`, `requireInputAdmissionIn`, `acceptedInputIn`, `acceptedNativeInputIn`, `sourcePrimaryAddress`, `primaryAddress` and the `primary` arguments, the `admission` field on `ChatSnapshot`, `ChatActivity`, and inspection contracts, the "historical conversation" banner and "Open primary conversation" button in `apps/web/src/features/product/conversation.tsx`, the `admission` prop that hides the reminder form in `conversation-activity.tsx`, and the Policy/Admission line in `conversation-inspector.tsx`.
2. `policyVersion` is always 1 now, so the field disappears rather than becoming a literal. Remove it from `ProfileIdentity`, `Bindings`, event claims, `CoordinatorEventDelivery`, `BotEventScope`, `instruction-cause.ts`, `coordinator-events.ts`, inspection contracts, and every `?? 0` default. `profileKey` and the extension name suffix derive from `agentVersion` alone. `publicationPolicy`, `legacy` flags, unsuffixed extension names, `legacyVersion`, and the `p0` regex in `restoreProfiles` go. `profileInstructions` always appends the coordinator overlay.
3. `coordinator-retired-events.ts` is not legacy. Keep it.
4. `allowLegacyUser` in `conversation-profile.ts` stays for now; a later unit removes it when coordination is always configured.
5. No code creates `kind: "slack"` conversation rows any more. Delete the Slack-kind notifier (`apps/server/src/session/slack.ts`), its wiring in `apps/server/src/session/agent.ts`, the `cerebro-notify` job and `scheduleNotify` in `session-agent.ts` and `notify` in `conversation-scope.ts` if nothing else observes them, `receiveSlackInteraction` and its route in `packages/channels/src/handler.ts`, and in `slack-replies.ts` the approval message, presentation fallbacks, `desiredSlackMessages`, and `deliverSlackReplies`. Keep `deliverSlackMessage`; `slack-event-replies.ts` uses it. Remove the `slack` case of `isCoordinatorConversation`. Drop the `kind` column's `slack` value and the Slack-only columns `channel_id`, `root_timestamp`, `slack_user_id`, `workspace_id`, plus `engine` and `retired_at`, from `channel_conversation` in `packages/db/src/schema/agents.ts`. If `kind` is then a single-valued column, drop it too and every `kind !== "web"` check. Generate one drizzle migration with `pnpm --filter @cerebro/db db:generate`; do not edit applied migrations.
6. `packages/runtime/src/conversation-work.ts` and `conversation-history.ts` are reachable only through policy version 0 tools. Delete both, the `search_conversations` entry in `packages/tools/src/tool-names.ts` and `inspection-native.ts`, the `cerebro-child` job, `search()` in `session-agent.ts`, the child UI in `conversation-activity.tsx` and `conversation-transcript.tsx`, the `children` projection in `conversation-snapshot.ts`, and `inheritDependencies` plus `content-dependency-store.inherit`, which lose their last caller.
7. The older identity-runtime retirement goes too: `deploy/cutover.mjs`, `deploy/cutover-core.mjs`, `deploy/retirement-sql.mjs`, the `--retirement-fence` handling in `deploy/backup.mjs`, `tests/integration/cutover.test.ts`, and the fence paragraph in `docs/operations/backup.md`. Keep `apps/server/src/retired-agent.ts` and its export in `apps/server/src/index.ts`: celld cannot delete a Durable Object class that a migration tag names.
8. `conversation-reminders.ts` "job-only seed" recovery (around `:312-324`, `:352-364`, `:385-397`): confirm that `create` commits the reminder document before it arms the job. If it does, delete the recovery branches and the "genuine legacy" test in `tests/runtime/conversation-reminders.test.ts:368`. If it does not, leave them and say so in the report.

## Delete entirely

- `packages/runtime/src/legacy-input.ts`, `coordinator-source.ts`, `source-admission.ts`, `conversation-work.ts`, `conversation-history.ts`.
- `packages/runtime/src/passive-history.ts`: remove `appendPassiveUser`; keep `appendPassiveAnswer`.
- `packages/channels/src/legacy-slack-input.ts`.
- `apps/server/src/session/legacy-timer-replies.ts`, `apps/server/src/session/slack.ts`.
- `deploy/cutover.mjs`, `deploy/cutover-core.mjs`, `deploy/retirement-sql.mjs`.
- `tests/runtime/legacy-slack-timer-replies.test.ts`, `legacy-work-replay.test.ts`, `source-admission.test.ts`, `coordinator-web-replay.test.ts`, `conversation-work.test.ts`, `conversation-history.test.ts`, `conversation-history-events.test.ts`.
- `tests/support/legacy-slack-timer-boundary.ts`, `tests/integration/cutover.test.ts`.

## Partially delete

packages/runtime/src
- `session-agent.ts`: the `accepted-legacy-input` request kind and `acceptLegacyInput`; `legacyTimerOrigin`, `publicationPolicy`, `conversationKind`, and `primaryAddress` in `SessionHostConfiguration`; the `prepareAdmission` loop; policy and legacy derivation in `createScope`; `restoreSelections`' `legacyVersion`; the `cerebro-source-cutover`, `cerebro-child`, and `cerebro-notify` jobs; `search()` and `scheduleNotify`.
- `conversation-scope.ts`: `sendLegacy`, `acceptLegacyInput`, the `/send` slack branch, the `legacy` flag and unsuffixed names, the `restoreProfiles` legacy alias and `p0` regex, `legacyVersion` retention, admission handling, `notify`, and stop-child. Keep `advance`; `policyVersion: 1` is the only value, so drop the field there as well.
- `conversation-profile.ts`: `requireFreshSourceIn`, the `profileInstructions` branch, the `legacy` suffix, legacy timer origin, `work` and `work.tools`, `routeHuman` and `replayHandled`.
- `conversation-bindings.ts`: `legacyVersion`, `policyVersion`, the v1 and v2 migrations; bump the document version and reject older versions.
- `coordinator-event-state.ts`: `legacyReceipt` and the v1 migrate; rename `legacyAdmission` to `admissionSchema`; drop `policyVersion`; bump the family version and reject older versions.
- `coordinator-ledger.ts`: `legacyLedgerSchema`, the `WorkLedger` migrate, the `WorkDocuments` v1 and v2 migrates; inline `legacyRecordSchema` into the current record schema; bump versions and reject older ones.
- `instruction-cause.ts`, `coordinator-events.ts`, `coordinator-event-scope.ts`, `conversation-event-scope.ts`: `policyVersion` and the `fresh()` guard.
- `saved-timer-state.ts`: `LegacyTimerReplyOrigin` input and pass-through.
- `saved-timer-submit.ts`: the `legacyTimerOrigin` fallback, the `acceptedLegacy` dedupe, and the source admission forwarding and paused wait. Keep the occurrence record, prepare, and admit logic.
- `coordinator-web.ts`: the replay branch for pre-event native submissions and `requireInputAdmissionIn`. Keep the conflict check for an operation ID already used by a team route; `coordinator-commands.ts` still writes `route: team` for stop-work operations.
- `coordinator-work.ts`: `rememberHumanOperation`.
- `coordinator-report.ts`: the `sourceSlackThread` legacy match.
- `coordinator-replies.ts`: the `LegacyTimerReplyOrigin` branch in `destination()`.
- `conversation-inspection.ts`: admission and primary in the overview frame.
- `conversation-snapshot.ts`: work children.
- `content-dependency-store.ts`: `inherit`.

packages/channels/src
- `slack-event-receipts.ts`: the `admit` decision member and type, the engine and retired filter, `readSlackEventTarget`; rename `legacyDigest` to `ignoredDigest`, since `ignored` decisions created today still use it.
- `slack.ts`: the `receiveAcceptedLegacySlackInput` fallthrough and `receiveSlackInteraction`.
- `slack-replies.ts`: as decided in item 5.
- `handler.ts`: the interaction route.
- `types.ts`: `admitLegacy`.
- `primary-conversations.ts`: the engine and retired gate and the `legacyKey` lookup in `openPrimaryConversation`.
- `conversations.ts`: `requireActive` and the retired list filter.
- `slack-primary-events.ts`: the engine and retired gate and `kind` check.
- `team-reports.ts`: the `sourceSlackThread` branch.

packages/contracts/src
- `work.ts`: `LegacySlackWorkAdmissionSchema` (inline its `sourceEventAddress` struct where V2 reuses it), the union member, `LegacySlackTeamReportDeliverySchema`.
- `timer-events.ts`: `LegacyTimerReplyOrigin`.
- `slack-events.ts`: the legacy union member.
- `session-service.ts`: the `admission` phases.
- `inspection.ts`: `policyVersion`, admission literals, and primary.

apps/server/src
- `session/agent.ts`: the `/legacy-slack-input` route, `requireLegacySourceMatch`, `legacyTimerOrigin`, `publicationPolicy`, `conversationKind`, the `primary` argument, the notifier, and `sourcePrimaryAddress`.
- `session/source-primary.ts`: delete the file if nothing remains.
- `session/slack-event-replies.ts`: the `primary` parameter and the legacy timer branches.
- `session/slack-event-client.ts`: `admitLegacy`.
- `session/proof.ts`: the route literal.
- `session/coordination.ts`: the `slack` case and `requireLegacySourceMatch`; update callers in `team-agent.ts`.
- `session/address.ts`, `session/client.ts`, `session/execution.ts`: the engine and retired gates.

deploy
- `backup.mjs`: the `--retirement-fence` option and its handling.

apps/web/src/features/product
- As decided in items 1 and 6.

## Tests

Delete the files listed above. Then, following the inventory:
- `tests/runtime/conversation-bindings.test.ts`, `event-migrations.test.ts`: remove migration cases for versions that no longer decode; keep a case that proves an older version is rejected if that is cheap.
- `tests/channels/slack-events.test.ts` (`:260`, `:296`, `:333`), `fixture-slack-events.ts` legacy fixtures, `primary-conversations.test.ts:195`, `web.test.ts:317-385`, `production.test.ts:384-391`, `coordinator-policy.test.ts:71-106`, `slack.test.ts:287` and the notifier delivery tests at `:388-787`, `tests/integration/session-transport.test.ts:91`, `tests/runtime/coordinator-handoffs.test.ts:535` and `:688`, `coordinator-web.test.ts:312`, `conversation-reminders.test.ts:368` (per decision 8), the `cerebro-child` and `search_conversations` assertions in `capabilities-journey.test.ts`, and `tests/channels/native/product.test.ts:29`.
- Rewrite: `tests/runtime/saved-timer-submit.test.ts` keeps its primary-only scenarios and drops the legacy ones; `tests/runtime/coordinator-web-fixture.ts` and the `conversation-publication*.test.ts` files stop modelling policy version 0 to 1 adoption and test agent-version bumps only; `coordinator-handoffs.test.ts:106` no longer uses `createCoordinatorSource`; fixtures that call `rememberHumanOperation` (`coordinator-fixture.ts`, `coordinator-recovery.test.ts`, `coordinator-fixture-provider.test.ts`, `coordinator-events.test.ts`) stop; legacy shapes in `tests/contracts/work-contracts.test.ts`, `tests/channels/team-reports.test.ts`, `inspection-ui.test.ts`, `inspection.test.ts`, and `tests/runtime/inspection-fixture.ts` go.
- Keep `tests/runtime/saved-timer-replies.test.ts`.
- `tests/channels/native/` is a Docker suite the lead runs; update its sources where they reference deleted symbols so they type-check, but do not run it.

## Docs

- `docs/architecture/overview.md`: remove the subagent and history-search paragraphs under "Delegated work" (keep the heading only if a paragraph about Teams remains), the Slack notifier sentence, the reminder job-seed sentence if decision 8 deletes that code, and the older retirement paragraph. Fix the code map rows for deleted files.
- `docs/architecture/slack-coordinator.md` and `docs/operations/agent-teams.md`: remove the sentences about historical roots, saved forks, and opening the primary.
- `docs/operations/backup.md`: remove the retirement fence paragraph.
- `docs/operations/slack.md`: remove anything that describes approval buttons or the thread notifier.
- Leave `docs/plans/` history untouched.

## Standards

- Read /Users/jhonsfran/repos/cerebro/.claude/CLAUDE.md and follow it. Run `pnpm check`; `pnpm fix` is allowed for formatting.
- No narrating comments. Keep a comment only for a non-obvious why.
- No compatibility shims, no optional fields kept "just in case", no renamed-but-retained legacy paths.
- Work in this order and run `pnpm check-types` after each step so a type error points at the step that caused it: (1) forks are already gone; delete source admission and the admission UI; (2) policy version and legacy naming; (3) legacy inputs, timers, and codecs; (4) Slack-kind rows, notifier, interactions, and columns; (5) conversation-work and history; (6) deploy retirement; (7) tests; (8) docs.

## Done when

1. `pnpm check-types`, `pnpm check`, and `pnpm test:contracts` pass.
2. `rtk proxy grep -rn -i "legacy\|policyVersion\|publicationPolicy\|retiredAt\|retired_at\|sourceSlackThread\|cutover\|historical" apps packages deploy tests docs --exclude-dir=node_modules --exclude-dir=dist` reports only `allowLegacyUser`, `acceptLegacyGroupSchema` in `packages/auth`, `_legacyRequestLimit` in `apps/server/src/config.ts`, `pinnedAgent`, the `agent:N` policy version strings in authorization, tools, and audit, `packages/api/src/routers/identity.ts`, `retired-agent.ts`, and files under `docs/plans`.
3. The new drizzle migration drops the columns named in decision 5.

Do not run `pnpm test:channels`, `pnpm test:runtime`, or `pnpm test:integration`; the lead runs them after review. Report the exact commands you ran with results, every file deleted, every change outside this brief and why, anything in the brief that was wrong, and the outcome of decision 8.
