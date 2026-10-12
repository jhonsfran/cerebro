---
name: verify-cerebro
description: Verify Cerebro's web workspace and supporting API in an isolated local Docker stack. Use after changes to account setup, agents, conversations, approvals, connectors, or skills, and when you need browser evidence of user-visible behavior.
---

# Verify Cerebro

Drive the real web app with the Codex in-app browser. Use the existing `tests/slice-1` stack for PostgreSQL, MinIO, celld, and the web app. It replaces only the external model and connectors through the normal runtime configuration. It does not require a real model key.

Read [features/README.md](features/README.md), then the relevant feature file. Cover each listed entry point required by the task. A single path does not prove every sub-feature.

## Launch

Run shell commands from the repository root. Requires Docker Compose, Node 22 or newer, pnpm 11, and `rtk`. Install missing workspace dependencies with `rtk proxy pnpm install --frozen-lockfile`.

```sh
VERIFY_RUN_ID="verify-$(rtk proxy node -e 'process.stdout.write(require("node:crypto").randomUUID().slice(0,8))')"
rtk proxy node .agents/skills/verify-cerebro/scripts/control.mjs launch "$VERIFY_RUN_ID"
```

The helper chooses three separate loopback ports and a fresh `cerebro-s1-verify-*` Compose project. It builds from this checkout and refuses to reuse a run directory. Allow up to 20 minutes for the first build. The launch process may need host Docker access outside the filesystem sandbox.

Ready means the command exits with code 0 and prints `ok: true`, `apiUrl`, `webUrl`, and `fixtureUrl`. It saves state before boot so a failed launch can be cleaned up. Use the printed `webUrl`, including its port and `localhost` hostname. The frontend uses that exact API origin and hostname.

Do not drive the user's `cerebro` project on ports 3001 and 18765. Do not reuse another test's stack or browser tab. Parallel runs have separate projects, ports, volumes, and evidence directories. Browser cookies are host-scoped, so different localhost ports share cookie names. Run one authenticated browser verification at a time in a shared browser profile. Close that tab and sign out before another run. A distinct Docker project alone does not isolate browser authentication.

After any application source change, clean up and launch a fresh build. The recorded SHA identifies HEAD; `sourceCheckoutDirty` states whether the build included local changes. It does not detect later edits.

Teardown is the `cleanup` command below. Run it after every failed attempt too. Do not use `pnpm stop`, `docker compose -p cerebro down`, or process-name kills.

## Doctor

```sh
rtk proxy node .agents/skills/verify-cerebro/scripts/control.mjs doctor "$VERIFY_RUN_ID"
```

This reads the instance and writes only `doctor.json` in the evidence directory. It checks HEAD, boot identity, disposable ownership labels, running containers, recorded image IDs, loopback port bindings, the fixture SHA, API `/ready`, web `/login`, and HTTP 401 from unauthenticated `/api/product/setup`. Require exit code 0 before browser work and whenever the instance looks wrong. After login, also require the workspace to show the signed-in test user. The doctor does not read a browser session or prove that user's permissions.

## Drive

Use `mcp__cua_repl.js` for browser actions. On its first call, use only this entry point, with the `webUrl` printed by doctor in place of the string value:

```js
let tab = await cua.createBrowserTab("iab", "http://localhost:57448/login", {
  visible: false,
});
```

That port is the original proof run, not a fixed app port. Read the returned browser documentation. Keep one tab handle and take a DOM snapshot after each group of actions:

```js
await tab.playwright
  .getByLabel("Name", { exact: true })
  .fill("Verification Owner");
await tab.playwright
  .getByLabel("Email", { exact: true })
  .fill("verification-owner@example.test");
await tab.playwright
  .getByLabel("Password", { exact: true })
  .fill("Verification-local-2026!");
await tab.playwright
  .getByRole("button", { name: "Sign Up", exact: true })
  .click();
nodeRepl.write(await tab.playwright.domSnapshot());
```

These credentials belong only to the disposable local stack. Never reuse a person's credentials. If the browser is already signed in on localhost, sign out through that verification tab before creating the test account. If that would affect the user's active session, use a separate browser profile or report the isolation blocker.

Read the stack's setup token with `rtk proxy node .agents/skills/verify-cerebro/scripts/control.mjs token "$VERIFY_RUN_ID"`. Fill `Installation token`, click `Set up workspace`, and require `Create your first agent`. Do not save the token, password, or cookie in proof files. Continue with the feature recipe. No browser state setters, injected click scripts, direct DB writes, or fixture control endpoints may replace the action under verification.

Use visible labels and roles from a current snapshot. If a label changed, inspect the page and update the map. Do not guess coordinates. Reload and navigation can return before the workspace finishes loading. Wait for the expected heading or region with `locator.waitFor({ state: "visible", timeoutMs: 20000 })`, then inspect a new snapshot. For chat completion, wait for `getByText("Cerebro slice 1 completed.", { exact: true })`. A fresh stack has no seeded company source, no agents, no skills, and no extra company principals. The model ID is `fixture/slice-1`. The provider returns that sentence after a plain chat message.

## Evidence

All proof files go in `artifacts/verification/$VERIFY_RUN_ID/`. The stack also keeps `boot.json` and its Compose override in `artifacts/slice-1/<recorded SHA>/<recorded project>/`.

For each proof, save the feature ID, entry point, exact action, expected result, actual result, and verification status in `proof.json`. Use `PASS`, `FAIL`, or `NOT_RUN` per path. Include launch/doctor output, screenshots before the action and after its result, DOM snapshots, and a read-only persistence check. For chat, also capture the submitted message and the same conversation after reload. Record relevant browser errors. Redact passwords, tokens, and cookies before saving snapshots.

```sh
rtk proxy node .agents/skills/verify-cerebro/scripts/control.mjs observe "$VERIFY_RUN_ID"
```

`observe` saves `observations-<timestamp>.json` with database counts, agent identifiers/names, skill contents, and fixture model/connector counters. Run it before and after a mutation to prove the change. It uses `BEGIN READ ONLY`. These files contain synthetic test data only.

For browser screenshots, use `await tab.screenshot({ fullPage: true })`, save the returned bytes as `.jpg`, and retain a DOM snapshot with `await tab.playwright.domSnapshot()`. In the CUA REPL, `await import("node:fs/promises")` can save those bytes and strings to this run's absolute evidence path. Capture credential forms before filling secret fields or after submitting them. A screenshot alone is not a complete proof.

External fakes are allowed only at the model and connector boundaries already defined by this repo. Their counters prove local dispatch and side effects, not real-provider compatibility or answer quality. For a requested live-provider gate, read `tests/live/README.md` and use `pnpm test:pi:live` with an authorized isolated configuration. Missing credentials are `NOT_RUN`.

`boot.mjs --dry-run` invokes Docker configuration reads and writes a Compose override in the artifacts directory. It does not start or exercise the app. Launch builds and may download images or packages. Do not call either operation network-free merely because the provider is fake.

## Cleanup

Sign out the disposable test user through the user menu if it is present. Close only the tab this run created with `await tab.close()`. Then run:

```sh
rtk proxy node .agents/skills/verify-cerebro/scripts/control.mjs cleanup "$VERIFY_RUN_ID"
rtk proxy ls "artifacts/verification/$VERIFY_RUN_ID"
```

The helper invokes the existing label-checked teardown with the recorded SHA, even if HEAD changed. It removes only this run's containers and volumes, then checks that both counts are zero. It saves `cleanup.json` and keeps all evidence and boot metadata. Confirm `proof.json`, screenshots, and observations still exist after cleanup. Never delete the whole artifacts directory. If cleanup fails, report the project ID and failure; do not switch to a broad Docker prune.

## Helpers

`scripts/control.mjs` is executable. From the repository root, call it through `rtk proxy node .agents/skills/verify-cerebro/scripts/control.mjs COMMAND "$VERIFY_RUN_ID"`:

- `launch` creates and builds a fresh isolated stack, then runs doctor.
- `doctor` checks the instance and saves `doctor.json`.
- `token` prints only this stack's bootstrap token. Do not redirect it to an evidence file.
- `observe` saves database and fixture observations without changing app state.
- `cleanup` removes this run's containers and volumes while preserving evidence.

The app's feature map is maintained in this directory. Use `/maintain-verification-skill` when routes, controls, or behavior change.
