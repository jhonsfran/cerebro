# Deterministic application stack

These files run the real application with a fake model and fake connectors. The integration tests, the native channel tests, and `pnpm start:demo` use them. Production code knows nothing about them: the fake is configured through an ordinary local `runtime.json`.

## Files

| File | Purpose |
| --- | --- |
| `compose.test.yaml` | Added to `compose.yaml`. Starts the `fixture` provider and runs `test-config` before `bootstrap`. |
| `Dockerfile` | The test image with `provider.mjs` and `runtime-config.mjs`. Test services are images, not bind mounts, so `deploy/backup.mjs` can back them up. |
| `provider.mjs` | The fake OpenAI-compatible model, MCP read connector, and write connector. |
| `runtime-config.mjs` | Writes `runtime.json` for the fake model, the `fixture-read` tool, and the `fixture_effect` write tool. |
| `boot.mjs` | Boots, kills, and removes an isolated, labeled test project. |
| `application.ts` | Test helpers: `bootApplication`, `applicationFixture`, and `initializeFixtureAgent`. |
| `probe.mjs` | Self-test for the fake provider, and a probe for a running one. |
| `compose-validation.env` | Values for parsing the production Compose files. Never deploy them. |

## Boot a test stack

```sh
node tests/slice-1/boot.mjs --project cerebro-s1-local --api-port 28765 --web-port 4001 --fixture-port 28090
```

Each boot needs a fresh `cerebro-s1-*` project and three distinct ports. It labels its containers and volumes `cerebro.slice-1=disposable` and writes `boot.json` under `artifacts/slice-1/<sha>/<project>/`. Add `--fixture-only` to start only the provider, or `--dry-run` to validate the Compose configuration.

Setup needs the generated bootstrap token. `applicationFixture(boot).bootstrapToken()` reads it from the secrets volume. `initializeFixtureAgent` grants the owner the fixture tools, ingests the `pilot-source` document through the memory API, and publishes an agent.

To remove the stack:

```sh
node tests/slice-1/boot.mjs --project cerebro-s1-local --api-port 28765 --web-port 4001 --fixture-port 28090 --down
```

Removal checks the ownership labels and deletes only that project's containers and volumes. If HEAD changed since the boot, add `--state-sha <sha-from-boot.json>`.

## Fake provider

The provider stores its counters in `slice-1-fixture` inside the project's `celld` volume and serves them at `GET /observations`. It never deduplicates calls, so a repeated physical write shows up in the counts.

- **Model** (`POST /v1/chat/completions`, `Bearer fixture-model-key`): when the last user message contains `fixture_effect` or "approval fixture", the model calls `fixture_effect`. When it contains `fixture-read`, the model calls `fixture-read`. After a tool result, or without a tool, it answers "Cerebro slice 1 completed." A call's identity is the `X-Fixture-Request-Id` header, or a digest of the messages up to the last user message.
- **Connectors** (`POST /mcp` and `POST /effects`, `Bearer fixture-connector-key`): changed input under one operation ID returns 409.
- **Controls** (`POST /control`, header `X-Fixture-Control: slice-1-control`): `delayMs` sets the delay between streamed frames. `failFirst` returns one 503 per model identity. `arm` holds a connector response at `before-tool-dispatch` or `after-tool-dispatch`. `{ "release": true, "arm": null }` releases held responses.

To kill `celld` while a write is held:

```sh
node tests/slice-1/boot.mjs --project cerebro-s1-local --api-port 28765 --web-port 4001 --fixture-port 28090 --kill-at after-tool-dispatch
```

Run this before you drive the scenario. It waits up to 60 seconds for the armed checkpoint, then sends SIGKILL to `celld`.

## Checks

```sh
node tests/slice-1/probe.mjs --self-test
node tests/slice-1/probe.mjs --fixture-url http://localhost:28090
docker compose --env-file tests/slice-1/compose-validation.env -f compose.yaml -f compose.production.yaml config --quiet
```
