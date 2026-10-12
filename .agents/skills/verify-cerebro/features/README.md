# Cerebro verification map

Read this index before driving the web workspace. The feature files describe user entry points and observable proof. They are the maintained source for later verification runs.

## Baseline preconditions

- Launch a fresh stack with `scripts/control.mjs launch` as specified in [SKILL.md](../SKILL.md).
- Require doctor to pass for the same run ID. Use its `webUrl` and a tab created for this run.
- The stack has a fake model, `fixture/slice-1`, and local fixture connectors. It starts without users, agents, company sources, skills, or additional principals.
- Account setup produces `Verification Owner`. Recipes after setup assume this owner is signed in.
- Run one authenticated verification at a time in a shared browser profile. Localhost cookies are shared across ports.
- Keep state and evidence under `artifacts/verification/<run ID>/`. Do not drive the user's existing stack.

## Driving conventions

- `tab` is the CUA tab from SKILL.md. Run each recipe's JavaScript through `mcp__cua_repl.js`.
- Get a current `tab.playwright.domSnapshot()` before choosing controls and after each action group.
- Exact button names differ between empty, create, and edit states. Use the stated preconditions.
- Read persistence and dispatch evidence with `control.mjs observe`. Never use its absence of an error as proof of a UI result.
- Keep credentials out of saved DOM text and screenshots. Sign out and close the run's tab during cleanup.

## Proof and skip reporting

- Capture the user action, its result, and persistence or side effects. Include a screenshot and DOM snapshot.
- Reload after a saved mutation. For chat, retain the conversation URL and reload that same URL.
- Record status per feature ID and entry point. Do not mark a skipped branch as verified through another branch.
- A branch needing unavailable source ingestion, a second principal, Slack, or live-provider credentials is `NOT_RUN`, with the unmet precondition.

## Features

- [Account and workspace setup](account-setup.md) covers signup, signin, initial owner claim, and signout.
- [Agents and access](agents.md) covers both creation entry points, publishing versions, cancellation, and permission controls.
- [Conversations and approvals](conversations.md) covers both conversation entry points, sending, reconnecting, persistence, stop, and approved or denied writes.
- [Connectors](connectors.md) covers the catalog, adding an MCP connector, refresh, and removal.
- [Skills](skills.md) covers creating, editing, and removing company playbooks.

Company memory retrieval and Slack are secondary API/channel paths. The web app exposes source selection and citations but no source-ingestion UI. Use `pnpm test:memory` for retrieval integration, `pnpm test:channels:native` for deterministic channels, and the live check described in `tests/live/README.md` when specifically required. These commands do not replace a changed web path's browser proof.
