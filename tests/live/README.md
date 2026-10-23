# Run the credentialed Pi gate

`pnpm test:pi:live` uses an existing isolated local application, one live model, and one real controlled MCP read. Enable only that read tool in the agent. Give the agent explicit access to the tool, its connector, and its resources. The tool must not require approval. Both external endpoints must use HTTPS. The command creates a fresh conversation and preserves its durable history.

Set `CEREBRO_PI_LIVE_CONFIG` to a private JSON file outside the repository. Include `apiUrl`, `webUrl`, `cookie`, `agentId`, `modelId`, `toolId`, `prompt`, `fixtureId`, and `runtimeConfigurationPath`. Use loopback for both application URLs. Supply the actual local `runtime.json` that contains the selected model and MCP read tool. The prompt must supply the permitted read arguments and request exactly one tool call. Use an existing test user's session cookie.

```sh
rtk proxy env CEREBRO_PI_LIVE_CONFIG=/private/tmp/cerebro-pi-live.json pnpm test:pi:live
```

The test submits `operationId` and `text`. It decodes the public `ChatReceipt` and `ChatSnapshot` contracts. Acceptance requires one successful MCP tool execution and a complete assistant answer after its result. A repeated submission must return `accepted: false` and preserve the tool execution and answer IDs.

The evidence file contains identifiers, replay status, and checkout state. Its path is `artifacts/slice-1/<SHA>/pi-live-<ID>/acceptance.json`. The file excludes credentials, the prompt, tool arguments, tool output, and answer text. Missing configuration reports `NOT_RUN` and fails the command. Local helper tests validate contract decoding and polling. They do not satisfy this credentialed gate.

Run the local helper tests without credentials.

```sh
rtk proxy node --test tests/live/pi-acceptance.test.ts
```
