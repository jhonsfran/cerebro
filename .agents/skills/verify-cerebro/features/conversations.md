# Conversations and approvals

Each person has one primary coordinator conversation per agent. Web input and filtered Slack events use it. Private background Teams have separate cells. Historical execution, approvals, and forks retain their saved state.

## Sub-features

- `conversation-start` opens or resumes the same primary through each visible open control.
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

- With an agent selected, choose `Open conversation` in the workspace header.
- In a historical conversation with closed ordinary admission, choose `Open primary conversation`.
- Open a saved `/dashboard` URL with its `conversation` search parameter.
- In the conversation panel, use `Message`, `Send message`, `Disconnect`/`Reconnect`, and the in-flight `Stop` control.
- In `Approval required`, choose `Approve request` or `Deny request`.

## Driving it with CUA

Preconditions:

- `Verification Assistant` exists with model `fixture/slice-1` and no selected tools for plain chat.
- Historical approval, foreground subagent, and foreground history paths need genuine already accepted retained policy-0 work. The fresh stack has none. Use an actual old-binary fixture with accepted work and its original grants, or report NOT_RUN. The authority helper in `tests/slice-1/application.ts` grants access but does not create pre-cutover acceptance. Do not seed accepted state or send fresh ordinary input to archived roots or forks.

- **Open through each entry.** Click `getByRole("button", { name: "Open conversation", exact: true })`. Require region `Conversation` and an enabled `Message` field. Save the URL. Open the same agent again and require the same URL and primary row. A historical closed conversation uses `Open primary conversation` to reach that same primary.
- **Send.** Run `await tab.playwright.getByLabel("Message", { exact: true }).fill("Hello verification")`, capture the filled composer, then `await tab.playwright.getByRole("button", { name: "Send message", exact: true }).click()`. Require both `Hello verification` and `Cerebro slice 1 completed.` in the conversation. Wait for the completed response through a current snapshot. Compare fixture model observations before and after.
- **Reload.** Run `await tab.reload()`. Require the same saved URL, agent name, submitted message, and response. Do not start a new conversation to prove recovery.
- **Reconnect.** Click `Disconnect`. Require disabled `Message` and control `Reconnect`. Click `Reconnect`; require an enabled composer and unchanged message history.
- **Stop.** Start a long-running request in a fixture prepared with a model delay, then click the visible `Stop` button. Require the run to leave its busy state and the composer to recover. A fast response without a visible Stop control does not prove stopping. The delay is fixture preparation at the existing model boundary.
- **Approve retained write.** Open the authentic retained conversation with its already accepted pending write. Require region `Approval required` and heading `fixture_effect`. Run `observe` and require no new physical write. Click `Approve request`, require the existing execution to complete, and require one new write with a saved receipt. Reload and require no second physical write. Without that accepted fixture, report NOT_RUN.
- **Deny retained write.** Open a separate authentic already accepted pending legacy approval. Click `Deny request`. Require the approval to resolve and no physical write. Retain the denial and observations. Do not create a fresh primary or submit a new historical prompt for this case.
- **Fork.** Send two distinct messages. Click `getByRole("button", { name: "Fork from this message", exact: true })` on the first completed message. Require a new conversation URL, the inherited prefix, and no later parent message. Require closed ordinary admission on the retained fork. Reload and require its URL, saved prefix, and definition pin. Use `Open primary conversation` for new input. Native fixtures cover accepted historical work and timers. Compare stored conversation counts and origin fields.
- **Retained subagent compatibility.** Open genuine already accepted old delegation. Expand Activity in `Conversation activity`. Require the saved child, its transcript, and parent tool. Reload and require the same child ID. Fresh primaries use private Teams. Without the accepted fixture, report NOT_RUN. `tests/runtime/capabilities-journey.test.ts` covers native child approval, restart, deadline, and scoped Stop.
- **Retained history compatibility.** Open a genuine already accepted legacy history search with permitted source evidence. Inspect its saved history child and `search_conversations` result. Require the exact source conversation and original entry citation. Fresh primaries have no foreground history child. Without the accepted fixture, report NOT_RUN. The native capability journey covers current source and receiver denial, forks, and original web-event evidence.
- **Work recall.** With a completed Team from the Inspector recipe, ask its coordinator to recall that recommendation. Require `recall_work` activity and evidence from the exact saved report. The coordinator must not start a replacement Team. Use the configured Team fixture or a separately recorded live-model run, not the plain fixed-answer baseline.
- **Reminder creation and delivery.** Send `Schedule a verification reminder`. Require a scheduled follow-up in activity. Reload the same conversation. After the 15-second fixture deadline, require `Run the scheduled verification check.` as a submitted input and one completed reminder. Compare fixture model counters and reload again to exclude duplicate delivery.
- **Reminder cancellation.** Open activity and fill **Instruction** and **First run (your local time)** with a future time within 366 days. Select a recurrence and its IANA timezone. Create the follow-up. Cancel its future occurrences, reload, and require its cancelled state. Native tests cover DST and recovery without an observer.
- **Compaction.** Choose **Compact context**. Require accepted control feedback and eventual removal of active compaction. Short chats can have nothing to summarize. A native journey with enough history proves the persisted summary and recovery after process termination. Compaction summaries appear under **Context summary** and do not offer forks.

## Gotchas

- The model's fixed sentence proves plumbing, not model quality. A real model check is separate.
- Wait for an enabled composer before sending. A visible panel can still be connecting.
- The fake provider recognizes `fixture-read`, `fixture_effect`, and `approval fixture` in prompts. A plain message avoids tool dispatch.
- New primary coordinators have conversation and Team tools. They do not execute foreground connector writes or foreground subagents. Use declared retained fixtures for those historical paths.
- Approval, stop, retrieval, citations, and Slack behavior are not covered by the plain chat proof. Record unmet preconditions as `NOT_RUN`.
- Do not use `/control` or a database update to create the resulting chat state. Preparation must be named separately from the action under test.
- The activity summary includes status text. `getByText("Activity", { exact: true })` does not match it. Use the current `summary.activity-summary` inside region `Conversation activity`.
- During the observed CUA reminder proof, filling `First run (your local time)` did not update the app's native input state until an `ArrowUp` key press followed by `Tab`. Use those keyboard actions on the filled datetime control, inspect its displayed value, and confirm the resulting schedule. Do not inject React state or dispatch replacement events.
