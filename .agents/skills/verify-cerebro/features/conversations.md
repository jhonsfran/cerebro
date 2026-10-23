# Conversations and approvals

A person sends messages to an agent, reloads a durable conversation, reconnects its transport, and approves or denies controlled writes.

## Sub-features

- `conversation-start` opens a private conversation through each visible start control.
- `conversation-send` sends a message and renders the response.
- `conversation-reload` preserves the same conversation and messages after reload.
- `conversation-reconnect` disconnects and reconnects the message transport.
- `conversation-stop` stops an in-flight run.
- `approval-allow` sends one write after approval.
- `approval-deny` denies a write without dispatching it.
- `conversation-fork` branches from a complete message and preserves the branch after reload.
- `conversation-subagent` delegates a task and displays its child transcript.
- `conversation-history-search` searches permitted earlier chats through a narrow child.
- `conversation-reminders` creates, restores, and cancels scheduled follow-ups.
- `conversation-compaction` requests a context summary and displays native status.

## How to get to it (user POV)

- With an agent selected, choose `New conversation` in the workspace header.
- In the welcome view, choose `Start a conversation`.
- Open a saved `/dashboard` URL with its `conversation` search parameter.
- In the conversation panel, use `Message`, `Send message`, `Disconnect`/`Reconnect`, and the in-flight `Stop` control.
- In `Approval required`, choose `Approve request` or `Deny request`.

## Driving it with CUA

Preconditions:

- `Verification Assistant` exists with model `fixture/slice-1` and no selected tools for plain chat.
- Approval paths need the agent's `fixture_effect` tool enabled and the user's execute/write/approve grants for that tool. The fresh browser baseline does not seed those grants. The existing `initializeFixtureAgent` in `tests/slice-1/application.ts` prepares such fixture authority for API tests. Use it only as declared preparation in a separately scoped proof, not as a substitute for UI actions.

- **Start through each entry.** Click `getByRole("button", { name: "New conversation", exact: true })`. In the welcome state, use `Start a conversation`. Require region `Conversation` and an enabled `Message` field. Save the URL. `observe` must show a new stored conversation per start.
- **Send.** Run `await tab.playwright.getByLabel("Message", { exact: true }).fill("Hello verification")`, capture the filled composer, then `await tab.playwright.getByRole("button", { name: "Send message", exact: true }).click()`. Require both `Hello verification` and `Cerebro slice 1 completed.` in the conversation. Wait for the completed response through a current snapshot. Compare fixture model observations before and after.
- **Reload.** Run `await tab.reload()`. Require the same saved URL, agent name, submitted message, and response. Do not start a new conversation to prove recovery.
- **Reconnect.** Click `Disconnect`. Require disabled `Message` and control `Reconnect`. Click `Reconnect`; require an enabled composer and unchanged message history.
- **Stop.** Start a long-running request in a fixture prepared with a model delay, then click the visible `Stop` button. Require the run to leave its busy state and the composer to recover. A fast response without a visible Stop control does not prove stopping. The delay is fixture preparation at the existing model boundary.
- **Approve write.** In a separately prepared authorized tool fixture, send `approval fixture`. Require region `Approval required` and heading `fixture_effect`. Run `observe` before approval and require no new entry with `write: true` in `observations.tools`. Click `Approve request`, require the completed response, then require exactly one new tool entry with `write: true`, a receipt, and `completedAt`. Reload and require no second physical write.
- **Deny write.** In a fresh authorized conversation, send `approval fixture`, then click `Deny request`. Require the approval card to resolve and no new write call or effect. Retain the denial state and observations.
- **Fork.** Send two distinct messages. Click `getByRole("button", { name: "Fork from this message", exact: true })` on the first completed message. Require a new conversation URL, the inherited prefix, and no later parent message. Send a branch-only message. Reload and require the branch URL and independent history. Compare stored conversation counts and origin fields.
- **Subagent.** Send `Delegate a verification task`. In region `Conversation activity`, click `summary.activity-summary` to expand **Activity**. Require one completed child, its title, its transcript, and its parent tool. Reload and require the same child ID. Use the native capability journey for pending child approvals, restart, deadline, and scoped Stop.
- **History search.** First send `Our launch decision is SQLite.`. Start another conversation with the same agent. Send `Search earlier verification conversations`. Expand the history child and its `search_conversations` output. Require the earlier public conversation ID and matching evidence. The fixture answer proves delivery, not model citation quality. Use native and policy tests for revoked or ungranted evidence.
- **Reminder creation and delivery.** Send `Schedule a verification reminder`. Require a scheduled follow-up in activity. Reload the same conversation. After the 15-second fixture deadline, require `Run the scheduled verification check.` as a submitted input and one completed reminder. Compare fixture model counters and reload again to exclude duplicate delivery.
- **Reminder cancellation.** Open activity and fill **Instruction** and **First run (your local time)** with a future time within 366 days. Select a recurrence and its IANA timezone. Create the follow-up. Cancel its future occurrences, reload, and require its cancelled state. Native tests cover DST and recovery without an observer.
- **Compaction.** Choose **Compact context**. Require accepted control feedback and eventual removal of active compaction. Short chats can have nothing to summarize. A native journey with enough history proves the persisted summary and recovery after process termination. Compaction summaries appear under **Context summary** and do not offer forks.

## Gotchas

- The model's fixed sentence proves plumbing, not model quality. A real model check is separate.
- Wait for an enabled composer before sending. A visible panel can still be connecting.
- The fake provider recognizes `fixture-read`, `fixture_effect`, and `approval fixture` in prompts. A plain message avoids tool dispatch.
- Approval, stop, retrieval/citation, and Slack behavior are not covered by the plain chat proof. Record unmet preconditions as `NOT_RUN`.
- Do not use `/control` or a database update to create the resulting chat state. Preparation must be named separately from the action under test.
- The activity summary includes status text. `getByText("Activity", { exact: true })` does not match it. Use the current `summary.activity-summary` inside region `Conversation activity`.
- During the observed CUA reminder proof, filling `First run (your local time)` did not update the app's native input state until an `ArrowUp` key press followed by `Tab`. Use those keyboard actions on the filled datetime control, inspect its displayed value, and confirm the resulting schedule. Do not inject React state or dispatch replacement events.
