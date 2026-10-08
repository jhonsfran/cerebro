# Local credentialed acceptance

`pnpm test:pi:live` uses an existing isolated local application, one configured live model, and one real controlled MCP read. The agent must have only that read tool enabled and must have explicit access to its resources. Fixture routes must be disabled. This command creates a fresh test conversation and preserves its durable history.

Set `CEREBRO_PI_LIVE_CONFIG` to a private JSON file outside the repository. The file must contain `apiUrl`, `webUrl`, `cookie`, `agentId`, `modelId`, `toolId`, `prompt`, `fixtureId`, and `runtimeConfigurationPath`. Both application URLs must use loopback. The runtime configuration must be the local application's actual `runtime.json`. The prompt must supply the permitted read arguments and request exactly one tool call. The cookie is an existing test user's session cookie.

```sh
rtk proxy env CEREBRO_PI_LIVE_CONFIG=/private/tmp/cerebro-pi-live.json pnpm test:pi:live
```

The test checks the agent's model and tool selection, the completed read, and one canonical output with the tool dependency. It saves identifiers and status under `artifacts/slice-1/<SHA>/pi-live-<ID>/acceptance.json`. It does not save credentials, the prompt, tool output, or answer text. Missing configuration reports `NOT_RUN` and fails the command. A deterministic fixture cannot satisfy this gate.
