# Unit 1: delete the conversation fork feature

Repository: /Users/jhonsfran/repos/cerebro, branch codex/persistent-super-agent. Work in place on this checkout. Do not commit; the lead reviews the diff and commits.

## Why

Every agent now has one persistent primary conversation per person. A fork creates a second web conversation that the source admission state machine archives as soon as it opens, so the fork button yields a frozen branch nobody can talk to. The feature, its contract, its runtime plumbing, its storage column, and its tests go. Pi's own `forkConversation` primitive stays: subagents and history search still create native forks internally.

## Delete, by package

packages/api
- `src/routers/product.ts:195-209` the `forkConversation` procedure and its route.

packages/channels
- `src/conversations.ts:102-189` and the `forkConversation` entry in the returned service object (`:391`).
- `src/primary-conversations.ts:52,62` drop `forkOrigin` from the Pick and the `!conversation.forkOrigin` term. A primary conversation is identified by its binding key and conversation ID alone.

packages/contracts
- `src/session-service.ts` remove `ConversationForkOrigin` (`:201-207`), `ChatForkReceipt` (`:237`), `ChatClient.fork` (`:265-271`), and `ChatActivity.origin` (`:141-146`).

packages/db
- `src/schema/agents.ts` remove the `ConversationForkOrigin` import (`:2`) and the `forkOrigin` column (`:63`).
- Generate the drop migration with drizzle-kit. Run `pnpm --filter @cerebro/db db:generate` (not through turbo, which marks it interactive). Expect a new `src/migrations/0020_*.sql` that drops `fork_origin` plus a journal entry and snapshot. Do not edit or delete `0016_conversation_forks.sql`; it is already applied in existing databases. If drizzle-kit prompts, answer so that the result is a plain column drop.

packages/runtime
- `src/session-agent.ts` remove: the `ChatForkReceipt` and `webEventForkPointIn` imports, the `UserEntry` and `AssistantEntry` imports if nothing else uses them, `origin` in `SessionHostConfiguration` (`:118-122`), the `forkCommand` and `nativeEntryId` schemas, the `ancestors` parameter and cycle check in `openScope` and `createScope`, `originKey` and its comparisons and the `origin` write into the binding, the `forkSource` call and method (`:616-685`), the "fork entry does not belong" check, the `tx.forkConversation` branch (keep `tx.createConversation`), the `inheritDependencies(origin.address, toolIds, false)` call, and the `/fork` request handler (`:916-951`). Keep `inheritDependencies` in the configuration; history search uses it.
- `src/coordinator-event-input.ts:32-66` remove `webEventForkPointIn`. Keep `webEventData`.
- `src/conversation-bindings.ts` remove `origin` from `ConversationBinding`. Bump the `Bindings` document to version 3 and make `migrate` throw `Unsupported conversation bindings version.` for anything older, the way other documents in this package reject unknown versions. Pre-cutover data is not migrated on this branch.
- `src/conversation-snapshot.ts:58-65` remove the `origin` copy into the activity snapshot.
- `src/content-dependency-store.ts:115-153` `inherit(source, toolIds, history)`: after this unit the only callers pass `history = true`. Remove the parameter and the `false` branch. Update `inheritDependencies` signatures in `session-agent.ts`, `apps/server/src/session/content.ts`, `apps/server/src/session/execution.ts`, `conversation-history.ts`, and the test fixtures to match.

apps/server
- `src/session/agent.ts` remove the `ConversationForkOrigin` import, the `forkOrigin` decode (`:131-140`), the `forkOrigin?.agentVersion` fallback (`:144`), and the `origin` mapping (`:203-218`).
- `src/session/client.ts` remove the `ChatForkReceipt` import, `"/fork"` from the path union, and the `fork` method (`:177-186`).
- `src/session/proof.ts:55` remove `"/fork"` from the allowed signed paths.

apps/web (src/features/product)
- `chat-connection.ts` remove `forkedConversationSchema` import and `forkConversation` (`:130-134`).
- `types.ts:116-120` remove `forkedConversationSchema`.
- `conversation.tsx` remove the `forkConversation` import, `forkIntent`, the `fork` handler (`:326-335`), and the `fork` prop (`:388`).
- `conversation-transcript.tsx` remove the `fork` prop, `forkable`, and the "Fork from this message" button (`:176-232, 299, 308, 381`).
- `conversation-activity.tsx:316,336-350` remove the "Forked from parent conversation" line.
- Keep `intent.ts`; other panels use it.

## Tests

- `tests/channels/forks.test.ts`: move the two tests that are not about forks before deleting the file. The test at `:305` ("chat controls reach their scope") and the "cannot control another identity's chat" assertions inside the test at `:209` belong in `tests/channels/conversation.test.ts`. Rewrite them to start from an ordinary primary conversation. Then delete the file and its entry in `tests/channels/run.mjs:143`.
- `tests/channels/fixture-session.ts` remove the `forkOrigin` inheritance in the fake read (`:146-200`) and the fake `fork()` (`:318-345`).
- `tests/channels/production.test.ts` remove the `/fork` transport stub (`:204-209`) and the fork placement, transport, and forgery rows (`:287-380`). Keep the non-fork rows.
- `tests/channels/coordinator-policy.test.ts:19` remove `forkOrigin: null`.
- `tests/channels/capabilities-ui.test.ts:181-255` remove the fork button test.
- `tests/integration/session-transport.test.ts` remove `"/fork"` from the path list (`:61`) and the fork half of the credential-binding test (`:220-240`); keep the `/control` half.
- `tests/runtime/helpers.ts` remove `ChatForkReceipt`, `reserveFork`, and `fork`. Keep `parentConversationId` at `:547`; that is Pi's native parent.
- `tests/runtime/fixture-contracts.ts:12` remove the `forkOrigin` schema.
- `tests/runtime/fixture-capabilities.ts` remove the `reserve-fork` route and the `fixture_fork_origin` table (`:10,24-60`). Keep the native parent columns at `:111-114`.
- `tests/runtime/fixture-session.ts:43,215-230` remove the fork origin read into the configuration.
- `tests/runtime/capabilities-journey.test.ts` delete the "reserved fork inherits" journey (`:20,28,107-190`) and trim the fork steps out of the history-search journey (`:816,882-889`) while keeping its history assertions.
- `tests/runtime/coordinator-web.test.ts` remove the `webEventForkPointIn` import and the "real Pi fork point" test (`:10,528-601`).
- `tests/runtime/content-dependencies.test.mjs:226-268` remove the `inherit(..., false)` test; keep the history inheritance test and adjust it to the new signature.
- Leave the Pi-level fork tests alone (`conversation-history.test.ts:509-521`, `source-admission.test.ts:386-426`, `metadata-queue.test.ts:254-322`, `coordinator-handoffs.test.ts:257-265`, `pi-presentation.test.ts:319`). They exercise Pi's primitive, not the product route.

## Docs

- `docs/architecture/overview.md`: rename the "Forks and delegated work" heading to "Delegated work", delete the fork paragraph (`:20-22`) and the sentence about a failed native fork at `:30`, and fix the `conversations.ts` row in the code map (`:128`) so it no longer says forks. Leave the other docs to a later unit.

## Standards

- Read /Users/jhonsfran/repos/cerebro/.claude/CLAUDE.md (Ultracite) and follow it. Run `pnpm check` and fix what it reports; `pnpm fix` is allowed for formatting.
- No narrating comments. Keep a comment only for a non-obvious why.
- Prefer deletion over rewriting. Do not add compatibility shims or optional fields.

## Done when

1. `pnpm check-types` passes.
2. `pnpm check` passes.
3. `pnpm test:contracts` passes.
4. `rtk proxy grep -rn -i "fork" apps packages tests docs --exclude-dir=node_modules --exclude-dir=dist` shows only Pi primitives: document `fork: "initial"` or `fork: "current"` options, `tx.forkConversation` in the Pi-level tests listed above, the memory repository CTE named `ancestors`, the `ancestors` WeakSet in `packages/contracts/src/tools.ts`, and historical plan documents under `docs/plans` and `docs/superpowers`.
5. The new drizzle migration exists and drops `fork_origin`.

Do not run the Docker suites (`test:channels`, `test:runtime`, `test:integration`); the lead runs them after review. Report the exact commands you ran with their results, every file you deleted, and anything in the brief that turned out to be wrong.
