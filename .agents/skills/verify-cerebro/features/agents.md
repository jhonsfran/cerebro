# Agents and access

An owner creates an assistant, selects its model and tools, publishes configuration versions, and controls which company principals can use it.

## Sub-features

- `agent-create-empty` creates an agent through the empty workspace prompt.
- `agent-create-sidebar` creates an agent through the sidebar button.
- `agent-publish` publishes changed instructions as a new version.
- `agent-cancel` exits an unsaved create or edit form.
- `agent-access` changes a principal's Read, Execute, and Approve grants.

## How to get to it (user POV)

- In an empty dashboard, choose `Create your first agent`.
- In the sidebar, choose the plus button named `Create an agent`.
- Choose an agent in the sidebar, then `Configuration` or `Access` in `Agent views`.

## Driving it with CUA

Preconditions:

- Account setup is complete and `Verification Owner` is signed in.
- Creation starts from the dashboard with no unsaved draft. Access changes need a second disposable principal with an existing company membership. A fresh stack has only the owner.

- **Open each create path.** Run `await tab.playwright.getByRole("button", { name: "Create your first agent", exact: true }).click()` in the empty state. For the sidebar path, use `getByRole("button", { name: "Create an agent", exact: true })`. Require heading `Create an agent` and fields `Agent name`, `Instructions`, and `Model`. Cancel and confirm no database agent appeared before trying another path.
- **Create agent.** Fill `getByLabel("Agent name", { exact: true })` with `Verification Assistant` and `getByLabel("Instructions", { exact: true })` with `Answer the user's question.`. Run `await tab.playwright.getByLabel("Model", { exact: true }).selectOption("fixture/slice-1")`. Leave tools and sources unchecked for the baseline. Click `getByRole("button", { name: "Create agent", exact: true })`. Require the named sidebar entry and `Version 1`. Reload and open that agent again. `observe` must show its name and one stored version.
- **Publish version.** Select the named agent in navigation `Agents`, then click `Configuration`. Change `Instructions`, click `Publish new version`, and require `Version 2`. Reload and require the changed field value. `observe` must show the version count increased by one.
- **Cancel draft.** Record observations, change a draft, then click `Cancel`. Reload and require the prior saved values and unchanged agent/version counts.
- **Change access.** Open `Access`. Use `getByLabel("read access for Verification Member", { exact: true })`, `execute access for Verification Member`, and `approve access for Verification Member` for a disposable member named `Verification Member`. Toggle one grant, reload, and require the stored checkbox state. In that member's browser session, prove the resulting permitted or denied action. Restore the grant. Without that second principal, report `agent-access` as `NOT_RUN`.

## Gotchas

- The sidebar entry includes an avatar and version. Scope it with `getByRole("navigation", { name: "Agents" })` and inspect its current accessible name before clicking.
- Every save publishes a version. Existing runs retain earlier versions; use a new conversation to check new configuration.
- Selecting an agent opens Configuration. `New conversation` opens its conversation.
- A selected tool does not prove the user's tool authority. A tool/approval proof must meet the conversation recipe's grants.
- Source choices are empty until memory ingestion occurs. Do not claim source retrieval from a plain chat response.
