# Tool catalog plan

Agents in Cerebro get tools from a catalog in PostgreSQL instead of the static `tools` list in `runtime.json`. Credentials move into encrypted accounts. Approval waits wake on the decision through an Effect `Deferred`, with no polling and their own expiry. The tool call path loses the broker, the loader isolate, and the HMAC capability, because all three run inside the same Worker today. Stale decision records go first.

The rule the program enforces is one call path. A tool call goes from `createPiTools` to the connector client to the upstream server, with one authority check before approval and one after it.

The PRs in order are PR-0 stale records, PR-1 approvals, PR-2 call path, PR-3 accounts, PR-4 catalog, and PR-5 MCP discovery. Code mode, skills, and the external MCP door come after this program.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `playbooks/autopilot-stack.md` from the poteto-mode skill. The operator lands the stack bottom-up. Every PR stops at merge-ready for the operator.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] On the operator's go, arm a `/goal` with this exact text. "Run docs/superpowers/plans/2026-10-12-tool-catalog.md. PRs in order PR-0, PR-1, PR-2, PR-3, PR-4, PR-5 as one stack on main. A PR is verified only when its unit, live, and perf boxes are checked. The operator lands the stack. Done when PR-5 is merge-ready with a clean verdict."
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/main:docs/architecture/overview.md`
  - [ ] `git show origin/main:docs/reference/runtime-configuration.md`
  - [ ] `git show origin/main:AGENTS.md`
  - [ ] The poteto-mode `playbooks/autopilot-stack.md`, `playbooks/opening-a-pr.md`, and the swarm skill, read from the skill folder.
- [ ] Arm the 30-minute audit tick with a terminal `/loop`. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook and the armed /goal. Audit the operation against both and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a status message to the operator in chat, whether or not anything changed, with the queue table of PR, owner, state, and head SHA, the verdicts since the last tick, what merged, open operator gates, and blockers."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Each PR bases on its parent branch.
  - [ ] PR-0 is first and branches from `main`.
  - [ ] PR-1 after PR-0.
  - [ ] PR-2 after PR-1. Both edit `packages/runtime/src/pi-tools.ts`.
  - [ ] PR-3 after PR-2. It edits the connector client that PR-2 creates.
  - [ ] PR-4 after PR-3. Catalog rows reference accounts.
  - [ ] PR-5 after PR-4. Discovery writes catalog rows.
- [ ] Hold the file boundaries. PR-0 touches only docs, `README.md`, and `.audit/`. PR-1 touches only `packages/contracts/src/approval-gate.ts`, `packages/runtime/src/{approval-store,pi-tools,session-agent}.ts`, `apps/server/src/session/agent.ts`, and `tests/runtime/`. PR-5 touches only `packages/tools/`, `packages/api/src/routers/`, and docs.
- [ ] Hold the review gate. PR-1 and PR-4 change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Use `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, with `gh pr create --base <parent-branch>`. PR-0 targets `main`.
- [ ] Run `pnpm check` and `pnpm check-types` once before the PR-facing push. Push with hooks on.
- [ ] Reread the diff and cut slop before each commit. Remove comments that restate code before review.
- [ ] Triage every Bugbot and security-reviewer comment per the poteto-mode `references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before babysit and again before the merge-ready report.

### Verdict and merge, for every PR

- [ ] At the merge-ready head SHA, run the swarm. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. One audit lane that reads the diff and the receipts and distrusts the PR body.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner. A new head gets a fresh swarm and a fresh verdict.
- [ ] The root appends the PR to the stack. The operator lands it bottom-up. The patch-id must stay unchanged after the final rebase.

### Boot recipe, for every live lane

Each live lane runs in its own git worktree at the PR head with its own Compose project name.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] `pnpm install --frozen-lockfile`, then boot the fixture stack the runtime tests use (`newStack` and `boot` in `tests/runtime/helpers.ts`), with the fake model and the fixture connector. Wait until `/health` returns 200.
- [ ] Drive chat through the fixture routes (`/runtime/send`, `/runtime/read`, `/runtime/decide`, `/runtime/fixture/access`) and the web UI at `http://localhost:3001` with the Playwright browser skill. Read logs with `docker compose logs celld bootstrap`.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## Delete stale decision records (PR-0)

**Depends on.** None.

**Files.**

- [ ] Delete `docs/architecture/adr-0001-replaceable-application-boundaries.md`.
- [ ] Delete `docs/superpowers/plans/2026-10-11-pi-native-runtime.md`.
- [ ] Delete `.audit/pi-native-runtime.tsv`.
- [ ] Edit `README.md` to drop the ADR link under Learn more.
- [ ] Edit `docs/architecture/overview.md` to add one paragraph on the future external MCP door and the catalog as the owner of tools.

**Build.**

- [ ] The overview is the single current description of the architecture. Rules from the ADR that still hold, Pi owns turns and tool tasks and no second execution store, already live in the overview and stay there.

**You see.**

- [ ] `git grep -n -e adr-0001 -e pi-native-runtime -- . ':!docs/superpowers/plans'` returns nothing.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Docs-only change. `pnpm check` passes. Run `pnpm check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.6-fast-xhigh` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Boot trunk and head and send one chat message. Save `boot-trunk-head.png`. Pass when both answer.
- [ ] Lane 2. Render `README.md` on the PR page. Save `readme.png`. Pass when every Learn more link resolves.
- [ ] Lane 3. Render `docs/architecture/overview.md`. Save `overview.png`. Pass when it names the catalog and the future external door.
- [ ] Lane 4. Run `git grep -n adr-0001 -- . ':!docs/superpowers/plans'`. Save `grep-adr.png`. Pass when it prints nothing.
- [ ] Lane 5. Run `git grep -n pi-native-runtime -- . ':!docs/superpowers/plans'`. Save `grep-plan.png`. Pass when it prints nothing.
- [ ] Lane 6. Run a link checker over `docs/` and `README.md`. Save `links.png`. Pass when no link is broken.
- [ ] Lane 7. Run `pnpm check`. Save `check.png`. Pass when it exits 0.
- [ ] Lane 8. Open `docs/reference/runtime-configuration.md`. Save `reference.png`. Pass when it has no ADR reference.
- [ ] Lane 9. List `docs/architecture/`. Save `arch-dir.png`. Pass when only `overview.md` remains.
- [ ] Lane 10. List `.audit/`. Save `audit-dir.png`. Pass when `pi-native-runtime.tsv` is gone.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Docs file count under `docs/architecture/`. Trunk lacks the deletion, so the rule is absolute.
- [ ] Probe. `ls docs/architecture | wc -l` on trunk and head.
- [ ] Baseline. Record the trunk count first.
- [ ] Rule. Fail when the head count is not 1.

**Review gate.** None. PR-0 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends PR-0 to the stack and the operator lands it.

## Wake approvals on the decision (PR-1)

**Depends on.** PR-0.

**Files.**

- [ ] Edit `packages/runtime/src/approval-store.ts`.
- [ ] Edit `packages/runtime/src/pi-tools.ts`.
- [ ] Edit `packages/runtime/src/session-agent.ts`.
- [ ] Edit `tests/runtime/fixture-session.ts` and `tests/runtime/native-journey.test.ts`.

**Build.**

- [ ] The approval store stays the one approval module and has no Pi types, so a future MCP host can reuse it. It gains `nextChange(approvalId)`, which registers an Effect `Deferred` before the caller reads the row, and `revalidate()`. `decide` completes the waiter after it writes the row. A separate `ApprovalGate` contract waits until a second host exists.
- [ ] `awaitDecision` in `pi-tools.ts` replaces the 250 ms loop. It reads the row, then waits for a decision or a revalidate hint. On a hint it rechecks authority once. Only `Denied` ends the wait.
- [ ] `session-agent.ts` calls `approvals.revalidate()` when the observer's 1 s access check or any request sees `Denied`.
- [ ] Approvals expire after `APPROVAL_TTL_MS`, 30 minutes. The dispatch deadline restarts after the decision, so a late Allow still dispatches.

**You see.**

- [ ] An Allow dispatches the write within 50 ms, a waiting approval makes no authority calls, and the approval card stays open for 30 minutes.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] All ten journeys in `tests/runtime/native-journey.test.ts` pass, including "pending approval survives SIGKILL with its native task binding; repeated Allow makes one physical write" and "Deny, wrong owner, and current access revocation prevent tool dispatch". Run `pnpm test:runtime`.
- [ ] Add a journey "Allow wakes the waiting tool without polling" that asserts dispatch within 50 ms of decide and zero authority calls while waiting. Run `pnpm test:runtime`.
- [ ] Add a journey "a transient authority failure keeps the approval pending" that makes the fixture authority return `Unavailable` once. Run `pnpm test:runtime`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.6-fast-xhigh` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Send "Apply fixture_effect once." and Allow it on trunk and head. Save `allow-trunk-head.png`. Pass when both write exactly once and head dispatches sooner than trunk.
- [ ] Lane 2. Deny a pending write. Save `deny.png`. Pass when the write count is 0 and the model answers that the action was denied.
- [ ] Lane 3. SIGKILL celld while an approval is pending, then Allow. Save `sigkill-allow.png`. Pass when the write count is 1.
- [ ] Lane 4. Revoke access while a browser observes a pending approval. Save `revoke-observed.png`. Pass when the run ends within 3 s and the write count is 0.
- [ ] Lane 5. Revoke access with no observer, then Allow. Save `revoke-unobserved.png`. Pass when decide returns 403 and the write count is 0.
- [ ] Lane 6. Leave an approval for 10 minutes, then Allow. Save `late-allow.png`. Pass when the write runs, because the TTL is 30 minutes.
- [ ] Lane 7. Press Stop while an approval is pending. Save `stop-pending.png`. Pass when the approval is `cancelled` and the session accepts a new input.
- [ ] Lane 8. Allow from the web UI approval card. Save `ui-allow.png`. Pass when the card shows allowed and the answer renders.
- [ ] Lane 9. Send Allow twice and Deny once for the same approval. Save `double-allow.png`. Pass when the second Allow returns the same receipt, Deny returns 409, and the write count is 1.
- [ ] Lane 10. Send a follow-up message while an approval is pending. Save `queued-input.png`. Pass when the message is queued and answered after the decision.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from the decide response to the dispatch memo, and authority evaluations per minute while a write waits.
- [ ] Probe. Twenty Allow cycles on trunk and head, interleaved, with timestamps from the runtime log and a counter on `authority.require`.
- [ ] Baseline. Record the trunk p50 latency and evaluations per minute first.
- [ ] Rule. Fail when head p50 latency exceeds 50 ms or head makes any authority evaluation while waiting without a `Denied` hint.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 8 and lane 10 screenshots into `docs/superpowers/media/PR-1-review-approval.png`.
- [ ] Record a 30 to 60 second video of a pending approval, a queued follow-up, and an Allow from the card. Save it as `docs/superpowers/media/PR-1-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends PR-1 to the stack and the operator lands it.

## Collapse the tool call path (PR-2)

**Depends on.** PR-1.

**Files.**

- [ ] Delete `packages/tools/src/broker.ts`, `packages/tools/src/dynamic-worker.ts`, and `packages/tools/src/capability.ts`.
- [ ] Rename `packages/tools/src/mcp-gateway.ts` to `connector.ts` and `apps/server/src/gateways.ts` to `audit-sink.ts`.
- [ ] Edit `packages/contracts/src/tool-service.ts`, `packages/contracts/src/tools.ts`, `packages/runtime/src/pi-tools.ts`.
- [ ] Edit `apps/server/src/{index,bindings,config}.ts`, `apps/server/src/session/agent.ts`, `apps/server/src/routes/health.ts`, `deploy/bootstrap.mjs`.
- [ ] Edit the runtime fixture, `tests/policy/*`, `tests/contracts/*`, `tests/support/*`, and the docs.

**Build.**

- [ ] `createConnectorExecutor` in `connector.ts` looks up the tool, supplies credentials, dispatches, redacts, and bounds the output. Any failure after the request is sent is `UnknownOutcome`. `ToolExecutor.execute` loses its capability argument, and `ToolCapability`, `toolCapabilityMatches`, and the Promise executor port are deleted.
- [ ] `createPiTools` keeps the authority check after approval and adds one after dispatch. A failed check withholds a read's output and turns a write into `UnknownOutcome`. The broker's approver recheck at dispatch is dropped, because decide already authorizes the person deciding.
- [ ] `gatewaySigningKey` stays. It also signs API requests to session objects, which is separate from tool dispatch.

**You see.**

- [ ] The Worker deploys without `TOOL_GATEWAY` or `LOADER`, and a read tool answers in chat.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] All journeys in `tests/runtime/native-journey.test.ts` pass against the real connector executor, plus "access revoked while a write runs reports an unknown outcome after one dispatch". Run `pnpm test:runtime`.
- [ ] `tests/runtime/isolation.test.ts` passes without the loader scenario, which tested a layer that no longer exists. Run `pnpm test:runtime`.
- [ ] Policy and channel suites pass. Run `pnpm test:policy && pnpm test:channels`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.6-fast-xhigh` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Ask a question that calls the fixture read tool on trunk and head. Save `read-trunk-head.png`. Pass when both answers cite the same tool output.
- [ ] Lane 2. Approve a fixture write. Save `write.png`. Pass when the write count is 1.
- [ ] Lane 3. Company A calls a tool, then company B reads. Save `tenant.png`. Pass when B sees none of A's output.
- [ ] Lane 4. A connector returns a secret header value in its body. Save `redaction.png`. Pass when the answer omits the value.
- [ ] Lane 5. A connector returns more than `maxOutputBytes`. Save `oversize.png`. Pass when the tool reports the limit and nothing larger reaches the model.
- [ ] Lane 6. Revoke the tool grant between approval and dispatch. Save `revoked-grant.png`. Pass when the write count is 0.
- [ ] Lane 7. SIGKILL after dispatch of an at-most-once write. Save `unknown-outcome.png`. Pass when the chat shows the unknown outcome and the write count is 1.
- [ ] Lane 8. `/health` on head. Save `health.png`. Pass when it returns 200 without checking `TOOL_GATEWAY` or `LOADER`.
- [ ] Lane 9. Audit sink after a tool call. Save `audit.png`. Pass when one audit row exists for the call.
- [ ] Lane 10. Slack DM that calls a read tool. Save `slack.png`. Pass when the reply contains the tool result.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of one fixture read tool call from `execute` start to result.
- [ ] Probe. Fifty calls on trunk and head, interleaved, timed in the runtime log.
- [ ] Baseline. Record the trunk p50 and p95 first.
- [ ] Rule. Fail when head p50 or p95 exceeds trunk.

**Review gate.** None. PR-2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends PR-2 to the stack and the operator lands it.

## Store connector credentials as encrypted accounts (PR-3)

**Depends on.** PR-2.

**Files.**

- [ ] Create `packages/db/src/schema/accounts.ts`, `packages/db/src/repositories/accounts.ts`, and migration `0011_connector_account.sql`, additive only.
- [ ] Create `packages/tools/src/accounts.ts`.
- [ ] Edit `apps/server/src/{bindings,config}.ts`, `apps/server/src/session/agent.ts`, `deploy/bootstrap.mjs`, `deploy/secrets.mjs`, and the docs.

**Build.**

- [ ] A `connector_account` row holds `organization_id`, `id`, `label`, and `sealed`. The name avoids Better Auth's `account` table. `sealCredentials` and `openCredentials` use AES-GCM with the organization and account ID as additional data, keyed by the `account-key` secret.
- [ ] Bootstrap seals each connector's `credentials` from `runtime.json` into `connector:<connectorId>` and publishes the configuration without them. `credentials` becomes optional, so it can be removed after import. The Worker receives `ACCOUNT_KEY` and opens the account per call.

**You see.**

- [ ] `RUNTIME_CONFIG_JSON` has no connector credentials, and a tool call still authenticates upstream.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/integration/runtime-configuration.test.ts` checks that credentials import once per connector and never reach the Worker configuration. Run `pnpm test:integration`.
- [ ] The pilot reads `connector_account` and asserts that `sealed` does not contain the fixture token, then makes an approved write through it. `tests/policy/tool-boundary.test.ts` checks that a sealed value opens only with its key, organization, and account. Run `pnpm test:integration && pnpm test:policy`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.6-fast-xhigh` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Call the fixture read tool on trunk with config credentials and on head with an account. Save `auth-trunk-head.png`. Pass when both upstream requests carry the same header.
- [ ] Lane 2. Run bootstrap twice. Save `bootstrap-rerun.png`. Pass when the account count is unchanged.
- [ ] Lane 3. Query the `account` table directly. Save `sealed.png`. Pass when no plaintext token appears.
- [ ] Lane 4. Remove the key file and boot. Save `missing-key.png`. Pass when boot fails with a message that names the key file.
- [ ] Lane 5. Rotate an account's credential. Save `rotate.png`. Pass when the next call uses the new token without a redeploy.
- [ ] Lane 6. Disable a connector. Save `disabled.png`. Pass when its tool fails without opening the account.
- [ ] Lane 7. Upstream echoes the token. Save `echo.png`. Pass when the answer omits it.
- [ ] Lane 8. Two organizations with the same connector id. Save `two-orgs.png`. Pass when each call uses its own organization's account.
- [ ] Lane 9. Backup and restore with `deploy/backup.mjs`. Save `restore.png`. Pass when tools authenticate after restore.
- [ ] Lane 10. A config that still has `credentials`. Save `reject.png`. Pass when bootstrap rejects it with the field name.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time to open an account per call, and fixture read tool wall time. Trunk lacks accounts, so the open time has an absolute budget.
- [ ] Probe. Fifty calls on trunk and head, interleaved, with the open time logged on head.
- [ ] Baseline. Record the trunk tool call p50 first.
- [ ] Rule. Fail when the account open p95 exceeds 5 ms or head tool call p50 exceeds trunk by more than 5 percent.

**Review gate.** None. PR-3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends PR-3 to the stack and the operator lands it.

## Serve agent tools from the catalog (PR-4)

**Depends on.** PR-3.

**Files.**

- [ ] Add `connector_tool` to `packages/db/src/schema/connectors.ts`, create `packages/db/src/repositories/catalog.ts`, and migration `0012_tool_catalog.sql`.
- [ ] Create `apps/server/src/catalog.ts`.
- [ ] Edit `apps/server/src/config.ts`, `apps/server/src/channels.ts`, `apps/server/src/session/agent.ts`, `deploy/bootstrap.mjs`, and the docs.
- [ ] Edit `tests/channels/helpers.ts` and `tests/integration/pilot-restore.ts`, which named the dropped tables.

**Build.**

- [ ] A `connector_tool` row holds the organization, tool ID, connector ID, `source`, and the validated tool document as `definition`. `parseCatalogTool` validates it on read, and `createCatalogRegistry` builds the registry from catalog tools.
- [ ] Bootstrap replaces the rows whose `source` is `runtime.json` in one transaction, and publishes a Worker configuration with no tools. The session agent and the agent editor read the catalog. The `connector` table is left for PR-5, where MCP connectors need a URL and an account.
- [ ] The same migration drops schema drift that nothing reads. It drops `channel_item`, `channel_reply`, and four `channel_conversation` columns with `IF EXISTS`.

**You see.**

- [ ] The agent editor lists tools from the catalog, and a conversation started after a catalog change sees it without a redeploy.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] The pilot's tool calls and approvals pass with tools served from the catalog. Run `pnpm test:integration`.
- [ ] `tests/integration/runtime-configuration.test.ts` checks that the Worker configuration has no tools and catalog imports carry no credentials. The pilot checks the catalog rows. Run `pnpm test:integration`.
- [ ] Channel UI tests pass with catalog-backed `connectorChoices`. Run `pnpm test:channels`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.6-fast-xhigh` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Enable the fixture read tool in the agent editor on trunk and head, then ask a question. Save `editor-trunk-head.png`. Pass when both answers use the tool.
- [ ] Lane 2. Insert a new tool row and start a new conversation. Save `new-tool.png`. Pass when the model can call it without a redeploy.
- [ ] Lane 3. Change a tool's schema while an approval is pending. Save `version-change.png`. Pass when the pending approval no longer matches and nothing is written.
- [ ] Lane 4. Disable a tool in the catalog. Save `disabled-tool.png`. Pass when new runs do not offer it.
- [ ] Lane 5. A principal without the tool grant. Save `no-grant.png`. Pass when the tool is not offered.
- [ ] Lane 6. Run bootstrap twice. Save `import-rerun.png`. Pass when the catalog row count is unchanged.
- [ ] Lane 7. SIGKILL mid-run after a catalog change. Save `restart-catalog.png`. Pass when the resumed run uses the tool set it started with.
- [ ] Lane 8. Agent editor tool list. Save `editor-list.png`. Pass when it shows catalog names and descriptions.
- [ ] Lane 9. Two organizations with different catalogs. Save `catalog-tenant.png`. Pass when each sees only its own tools.
- [ ] Lane 10. A config that still has `tools`. Save `reject-tools.png`. Pass when bootstrap rejects it with the field name.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from Send to the first model request, which now includes the catalog read.
- [ ] Probe. Thirty Sends on trunk and head, interleaved, timed from the runtime log.
- [ ] Baseline. Record the trunk p50 first.
- [ ] Rule. Fail when head p50 exceeds trunk by more than 20 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 and lane 8 screenshots into `docs/superpowers/media/PR-4-review-editor.png`.
- [ ] Record a 30 to 60 second video of enabling a catalog tool and using it in chat. Save it as `docs/superpowers/media/PR-4-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends PR-4 to the stack and the operator lands it.

## Discover MCP tools with pi-mcp (PR-5)

**Depends on.** PR-4.

**Files.**

- [ ] Edit `packages/tools/package.json` to add `@earendil-works/pi-mcp` at exactly `1.1.0`.
- [ ] Delete `packages/tools/src/mcp-transport.ts`.
- [ ] Create `packages/tools/src/mcp-discovery.ts`.
- [ ] Edit `packages/tools/src/catalog.ts`, `packages/tools/src/mcp-gateway.ts`, `packages/api/src/routers/product.ts`.
- [ ] Edit `docs/reference/runtime-configuration.md`.

**Build.**

- [ ] `refresh(connectorId)` connects with `pi-mcp` over Streamable HTTP, pages `tools/list`, and replaces the connector's `connector_tool` rows in one transaction. `readOnlyHint: true` maps to `read`. Every other tool maps to `write` with `requiresApproval: true`.
- [ ] The connector client calls tools through `pi-mcp` `callTool` instead of the hand-rolled JSON-RPC request.
- [ ] A product route adds an MCP connector by URL and account, then runs `refresh`.

**You see.**

- [ ] Adding the fixture MCP server by URL lists its tools in the agent editor with read and write effects.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] A runtime journey adds a fixture MCP connector with one read tool and one tool without hints, and asserts the effects `read` and `write`. Run `pnpm test:runtime`.
- [ ] All ten native journeys pass over `pi-mcp`. Run `pnpm test:runtime`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.6-fast-xhigh` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk cannot add a connector by URL. Record that, and on head add the fixture MCP server and call its read tool in chat. Save `discover-head.png`. Pass when the answer uses the tool.
- [ ] Lane 2. A tool with no annotations. Save `unhinted.png`. Pass when calling it asks for approval.
- [ ] Lane 3. Refresh after the server adds a tool. Save `refresh-add.png`. Pass when the new tool appears and old rows keep their versions.
- [ ] Lane 4. Refresh after the server removes a tool. Save `refresh-remove.png`. Pass when the tool is no longer offered.
- [ ] Lane 5. A server that needs auth, added without an account. Save `unauthorized.png`. Pass when refresh fails with an authorization message and writes no rows.
- [ ] Lane 6. A server with 120 tools across pages. Save `paged.png`. Pass when all 120 rows exist.
- [ ] Lane 7. A server that times out. Save `timeout.png`. Pass when refresh fails within the configured deadline and existing rows stay.
- [ ] Lane 8. A tool that returns `isError: true`. Save `tool-error.png`. Pass when the model sees an error result.
- [ ] Lane 9. A tool that returns `structuredContent`. Save `structured.png`. Pass when the answer uses a structured field.
- [ ] Lane 10. A write tool approved through the UI. Save `mcp-write.png`. Pass when the upstream receives one call.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Refresh time for the 120-tool fixture server, and MCP tool call wall time. Trunk lacks discovery, so refresh has an absolute budget.
- [ ] Probe. Ten refreshes on head, and fifty tool calls on trunk and head, interleaved.
- [ ] Baseline. Record the trunk MCP tool call p50 first.
- [ ] Rule. Fail when refresh p95 exceeds 2 s or head tool call p50 exceeds trunk by more than 5 percent.

**Review gate.** None. PR-5 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends PR-5 to the stack and the operator lands it.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

Three design runners each committed to one shape and wrote a candidate. The files are in the session scratchpad under `approvals/`, `pi-native.md`, `effect-gate.md`, and `cloudflare-agents.md`. Facts checked at `86ec879` by reading code.

- The gateway is not a trust boundary. `TrustedGateway` is a `WorkerEntrypoint` of the same Worker, bound as `TOOL_GATEWAY` to service `cerebro-api` in `deploy/bootstrap.mjs`. `RUNTIME_CONFIG_JSON` with every credential is a var of that Worker. The loader isolate runs the constant `wrapperSource`.
- Decide and the waiting tool run in the same Durable Object. `session-agent.ts` line 555 calls `approvals.decide` on the storage the tool reads.
- The observer already checks access every second, `setInterval` at `session-agent.ts` line 467. A `Denied` there is the revalidate hint.
- Today an approval expires with the model `deadlineMs`, `deadlineAt` in `pi-tools.ts` comes from `provider.deadlineMs`. The fixture uses 300 s.
- Today a transient `Unavailable` from the 250 ms recheck ends the wait and the `finally` cancels the approval.
- Unproven. Whether the revocation journey passes through the observer hint without polling. All three runners inferred it, none ran it. PR-1 unit box 1 settles it.
- Unproven. Whether `@earendil-works/pi-mcp` runs on celld. PR-5 lane 1 settles it.

## Appendix B. Alternatives rejected

- Pi-native approvals, a `cerebro.approvals` Pi document waited on with `api.watchDoc`. It scored best on internal fit and deletes the most code. It lost because approval records then live in Pi state, and the future external door would need a Pi conversation and an unproven zero-token relay provider to reuse them. Grafted from it are no periodic recheck and a separate approval TTL.
- Cloudflare `agents` with `@cloudflare/codemode` runtime approvals. A pending approval ends the turn with `control: { terminate: true }`, so the chat is never busy. It lost on a second durable log next to Pi, a Lifecycle job instead of Pi performing the write, DO facets that celld has not proven, and keeping the loader binding that PR-2 deletes. The idea of ending the turn while an approval waits is kept as an open product question.
- A periodic authority recheck while waiting, at 5 s or 250 ms. All three runners rejected it. Authority is checked at decide, after Allow before dispatch, and through `policyVersion` in `boundApprovalMatches`, so a revoked user cannot cause a write. A recheck only ends runs sooner, which the observer hint and the TTL already bound. It cost about 720 authority evaluations per pending approval per hour at 5 s.
- Executor's memory-only `Deferred` with no durable row. A restart loses the pending approval.

## Appendix C. Risks

- PR-1. An unobserved revoked run stays busy until a request reaches the DO or the TTL ends. The owner checks lane 5.
- PR-1. Any org grant change moves `policyVersion` and voids pending approvals. Confirm with the operator that this is wanted.
- PR-1. The approval binding records the requester as `approverId`, not the person who decided. Recording `decidedBy` belongs with multi-approver support.
- PR-2. Deleting the HMAC capability removes defense if a future change adds untrusted code to this Worker. The owner records this in the overview.
- PR-3. Losing the account key loses every credential. The owner adds the key file to `deploy/backup.mjs`.
- PR-4. A schema change upstream invalidates pending approvals through `toolVersion`. Lane 3 covers it.
- PR-5. MCP tools without hints default to `write`, which adds approvals for servers that omit hints. This is intended.

## Appendix D. Links and reading list

- `docs/architecture/overview.md` and `docs/reference/runtime-configuration.md`.
- `packages/runtime/src/pi-tools.ts` and `packages/runtime/src/approval-store.ts` before PR-1 and PR-2.
- The `effect-gate.md` candidate for the `ApprovalGate` sketch, and Executor's `packages/mcp/src/implementation/executions.ts` for the `Deferred` pattern.
- `@earendil-works/pi-mcp` README on npm before PR-5.
- PR-1 and PR-2 get the how skill before editing. PR-1, PR-2, and PR-4 get the interrogate skill before merge.
- In Claude Code, `grok-4.6-fast-xhigh` lanes map to local general-purpose subagents, and the control skill maps to the Playwright browser skill.
