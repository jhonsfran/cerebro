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

## Gotchas

- The model's fixed sentence proves plumbing, not model quality. A real model check is separate.
- Wait for an enabled composer before sending. A visible panel can still be connecting.
- The fake provider recognizes `fixture-read`, `fixture_effect`, and `approval fixture` in prompts. A plain message avoids tool dispatch.
- Approval, stop, retrieval/citation, and Slack behavior are not covered by the plain chat proof. Record unmet preconditions as `NOT_RUN`.
- Do not use `/control` or a database update to create the resulting chat state. Preparation must be named separately from the action under test.
