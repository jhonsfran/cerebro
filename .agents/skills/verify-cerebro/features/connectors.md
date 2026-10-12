# Connectors

An administrator lists MCP servers, adds a server, refreshes its discovered tools, and removes an added server.

## Sub-features

- `connector-list` shows configured and administrator-added servers.
- `connector-add` discovers tools through the Add connector form.
- `connector-refresh` refreshes tools for an administrator-added server.
- `connector-remove` removes that server and its tools.

## How to get to it (user POV)

- On `/dashboard`, choose `Connectors` in the Administration navigation.
- Use the Add connector form, then the server row's `Refresh` or `Remove` control.
- Enable a discovered tool through an agent's Configuration view to make it usable by that agent.

## Driving it with CUA

Preconditions:

- The owner is signed in. The stack fixture is healthy. No administrator-added connector is named `verify-mcp`.
- Use the internal server URL `http://fixture:8090/mcp`. The API contacts it inside Docker. The bearer token is the fixture-only `fixture-connector-key`.

- **List.** Run `await tab.playwright.getByRole("navigation", { name: "Administration" }).getByRole("button", { name: /Connectors/ }).click()`. Require `MCP servers your agents can use` and file-configured `fixture-mcp`.
- **Add.** Fill `getByLabel("Connector ID", { exact: true })` with `verify-mcp`, `MCP server URL` with `http://fixture:8090/mcp`, and `Bearer token (optional)` with `fixture-connector-key`. Click `getByRole("button", { name: "Add connector", exact: true })`. Require `verify-mcp`, source `Added here`, a nonzero tool count, and a success output. Reload, reopen Connectors, and require that row again.
- **Refresh.** Scope the row with `tab.playwright.locator(".access-row").filter({ hasText: "verify-mcp" })`, then click its `Refresh` button. Require the success output and current tool count. Record fixture connector observations.
- **Remove.** In the same row, click `Remove`. Require `Removed verify-mcp and its tools.` and no `verify-mcp` row after reload. The file-configured `fixture-mcp` must remain. This action applies only to this run's synthetic connector.

## Gotchas

- File-configured connectors have no Refresh or Remove button. Removing a file connector is not a UI path.
- The browser uses localhost; the server must use Docker's `fixture` hostname.
- New connectors can call their server during discovery. Use the local fixture endpoint for deterministic verification.
- A discovered tool is not enabled automatically in an agent. Its read-only annotation also affects whether approval is needed.
- Redact the token field from pre-submit evidence. Do not enter real connector credentials for this baseline.
