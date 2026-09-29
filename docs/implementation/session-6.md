# Session 6 product and channels

Status. Session 6 development and local fixture verification pass. Final acceptance depends on sessions 2 through 5 and session 7 composition. This receipt does not qualify production integration.

Branch is `codex/web-slack`. Base is `c2b7ed1708b08a364f97652de5f0db363a67410d`. The latest base commit that changed contracts is `6cbe67e8ac97ae0767fb026f0e45d8ef472270d2`. This branch does not change the shared contracts. Other sessions can advance main independently; session 7 must integrate the tested subsystem commits.

## Product behavior

The workspace supports agent creation and immutable version publication, model and connector selection, execution grants, current human access, and budget status. The conversation route keeps one session ID. Message retries keep the event ID, and stream reconnect keeps the cursor. The interface shows fixture citations, tool activity, approval, cancellation, and execution history with source and audit dialogs. It identifies fixture evidence visibly.

Both web and Slack use the same channel service. The service rechecks current company-scoped policy for admission, duplicate receipts, reads, source access, approval, and reply delivery. Agent capabilities do not replace human grants. Installation setup is a local fixture action for one owner; later signups do not gain owner access. Publication and initial creator grants commit together. Replay does not restore a removed grant. Access replacement stores an operation digest and result in the same transaction.

Slack verifies the raw request HMAC and timestamp, then checks configured workspace and app IDs. Only linked direct-message threads enter the pilot. Link commands consume a hashed one-use challenge with a sanitized event receipt in one transaction. The clear code does not enter the inbox or transcript. Thread bindings and complete admission envelopes persist in PostgreSQL. A reply claim commits before the provider call. Each attempt has an ID. An ambiguous response or abandoned attempt becomes an unknown outcome and cannot retry automatically.

## Persistence and recovery

Migrations `0002`, `0003`, and `0004` add agent versions, channel admission and presentation records, reply state, projection state and cursor, and retry fairness timestamps. The fixture Worker schedules a repeating Durable Object alarm before channel admission. The alarm reschedules before a bounded drain. Pending submissions, active projections, and ready replies recover independently. Projection remains active until it reaches the terminal snapshot cursor. A completed reply requires persisted terminal stream evidence.

## Verification

| Check | Result | Evidence scope |
| --- | --- | --- |
| `rtk proxy pnpm test:channels` | 16 passed on fresh isolated PostgreSQL | REST behavior, immutable versions, duplicate messages, cursor reconnect, approval, current revocation on both channels, Slack signing/linking/thread binding, concurrent outbox claims, unknown outcomes, truncated projection, completion race, access replay, and retry fairness. Ten PostgreSQL behavior cases and six UI boundary cases. |
| Native API test | 1 passed | Authenticated product routes through actual celld, duplicate admission, source read, stream reconnect, approval, and outsider denial. |
| Native SIGKILL test | Passed twice; final total test duration 186523.37 ms | One stored pending inbox row produced one accepted run without a new channel request. |
| Browser flows | Passed | Actual agent creation, question, citation, disconnect/resume, approval, audit, saved-route agent resolution, agent switching, and Slack link command display. |
| `rtk proxy pnpm test:contracts` | 35 passed | Existing shared contract fixtures. |
| `rtk proxy pnpm test:identity` | 18 passed | Existing identity and authorization fixtures. |
| `rtk proxy pnpm check-types` | Passed | Workspace types. |
| `rtk proxy pnpm build` | Passed | Server bundle and browser/SSR builds. |
| Scoped Ultracite | Passed | All changed files. |
| Repository-wide `pnpm check` | Fails in unchanged files | Final run reports zero diagnostic lines in changed session 6 files. Existing UI, experiment, and `.agents` files remain outside this scope. |

The native API check also asserts CORS preflight 204 and the configured web origin. Browser verification exposed a preflight 500 because the outer middleware discarded the direct Hono Response. Returning that Response fixed browser sign-in.

The first fresh channel runner failed because the readiness probe reached the temporary PostgreSQL initialization server. The probe now uses TCP. The next fresh run passed. The native product test first failed on an incorrect source wording assertion; it passed after the assertion was aligned with the actual fixture text.

## Native fixture commands

```sh
rtk proxy env CEREBRO_API_PORT=18766 CEREBRO_WEB_PORT=3006 CEREBRO_PUBLIC_API_URL=http://localhost:18766 CEREBRO_PUBLIC_WEB_URL=http://localhost:3006 docker compose -p cerebro-s6 up --build -d --wait
rtk proxy env CHANNEL_NATIVE_API_URL=http://localhost:18766 bun test tests/channels/native/product.test.ts
rtk proxy env CHANNEL_NATIVE_API_URL=http://localhost:18766 CHANNEL_NATIVE_COMPOSE_PROJECT=cerebro-s6 bun test --timeout 360000 tests/channels/native/recovery.test.ts
```

The native recovery test kills celld, inserts a trusted pending inbox row into PostgreSQL while it is stopped, restarts celld, and checks one accepted run through SQL. It tests the durable recovery driver. The reported duration includes authentication, test setup, SIGKILL, restart, and polling. It is not an isolated restart-to-acceptance latency measurement. It does not prove an in-flight model or tool effect across a crash. The browser is closed during this check so no browser channel request can restart the wake path.

## Integration boundary

Live Slack is unconfigured and unrun. No real workspace result is claimed. The local route is fixture-only and installation-owner-only. Optional trusted Slack settings come from the mounted `channels.json` secret file, with company ID, workspace ID, app ID, agent ID, signing secret, and optional bot token. The signing secret and token stay outside the repository. `organizationId` is at the top level of the secret file; Slack settings are inside `slack`. A custom provider URL is accepted only in fixture mode.

Production does not select the fixture SessionService. Session 7 must compose real session, catalog, budget, memory/source, and audit adapters. The shared stream contract has run, output, and approval records. Citation and tool records in this session are typed channel-local fixture presentation. Immutable versions remain readable, but the current session envelope cannot prove an authoritative runtime version pin. Budget display is synthetic until the real authority is connected. Unknown Slack outcomes need operator reconciliation; the UI does not add an automatic resend control.

The inherited public PostgreSQL TLS and real model checks remain unproven. Session 3's explicit TLS exception does not qualify a production deployment. No capacity estimate follows from these single-user checks.

## Design and review

[Design alternatives](session-6-design.md) explain the shared service, REST interface, recovery driver, and unknown-delivery tradeoffs. [Decision log](session-6-decisions.tsv) records accepted choices and evidence limits. The implementation used separate API and UI owners. The coordinator owned manifests, migrations, Worker composition, deployment, and native verification.

Three Interrogate reviewer aliases inherit the parent model. Their reviews are independent tasks, but have no model diversity. [Review synthesis](session-6-review.md) records fixed findings, evidence, and the remaining audit-button UX limit.

Local code commits are `4f620ce` for the backend and `a03e758365e3686926a46c07a747a2aa4fd0e118` for the UI and runners. These application sources were tested before commit; commit hooks also passed. This receipt and the screenshots are a separate handoff commit. The repository has no Git remote, so no pull request was created.

## Applied principles

| Principle | Choice it changed |
| --- | --- |
| Model the Domain | Store explicit admission, projection, and reply states. |
| Boundary Discipline | Validate external payloads and enforce current policy at channel boundaries. |
| Type System Discipline | Use typed presentation records and parse API responses with Zod. |
| Make Operations Idempotent | Persist stable operation identities and replay receipts; preserve unknown delivery outcomes. |
| Separate Before Serializing Shared State | Give API and UI separate file owners; keep shared files with the coordinator. |
| Sequence Work into Verifiable Units | Commit verified backend, UI, and handoff changes separately. |
| Test Behavior, Not Implementation | Check persisted receipts, current revocation, reconnect, and stale response rejection. |
| Prove It Works | Test the actual PostgreSQL, celld, and browser paths. |
| Laziness Protocol | Keep one channel service and remove the unused barrel export. |

## Screenshots

- [Admin](evidence/session-6/admin.jpg) shows the published version and configuration.
- [Conversation](evidence/session-6/conversation.jpg) shows the cited answer after reconnect.
- [Approval](evidence/session-6/approval.jpg) shows the pending controlled fixture action.
- [Citation](evidence/session-6/citation.jpg) shows the fixture source content.
- [Audit](evidence/session-6/audit.jpg) shows stored admission and completion times.

The fixture Compose project `cerebro-s6` remains available for review at `http://localhost:3006`. Its API is at `http://localhost:18766`. The account `session6-pilot@example.test` uses the test-only password in `tests/channels/native/product.test.ts`. These credentials belong only to this isolated local fixture. Repeated native runs create separate test agents with fresh operation IDs. No real Slack message was sent.

The test runner removes its temporary PostgreSQL container. The separate development test container is removed at handoff. The native Compose volumes remain intact for review.

## Parent merge on 2026-09-30

The parent integration uses main at `5dd2211` and session 6 at `254de2a`. Sessions 5 and 4 completed while the merge was prepared in a separate checkout. No uncommitted parent files were stashed or changed.

The merge keeps both memory and channel test runners and registers both schemas. Parent migrations `0000` through `0004` remain unchanged. The generated `0005_session_6_channels.sql` creates the final channel schema in one migration. All 43 table definitions in its snapshot match the union of the parent and channel snapshots. The first five journal entries are unchanged. The branch's earlier channel migrations remain in its original history; the integrated parent uses the new sequence.

A merged Drizzle importer initially referred to a missing peer snapshot. Offline resolution corrected that importer. The channel test container now uses the exact pinned pgvector image from the parent because the combined migrations require the vector extension.

On the final combined tree, 16 channel tests, 23 memory tests, 63 policy tests, and 35 contract tests passed. Types, build, frozen offline installation, scoped lint, and diff checks passed. Twelve runtime tests passed during initial merge verification before session 5 completed; the runtime sources are unchanged in the final merge. Production adapter and live Slack limits remain as stated above.

The independent [parent merge review](session-6-parent-merge-review.md) passed against `5dd2211`. It found no merge-only defect.
