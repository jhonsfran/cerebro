# Cerebro

Cerebro is a self-hosted assistant for a company. People chat with agents that answer from company memory, call controlled tools, and ask for approval before they write anything. Every step checks the person's current permissions. Agents run on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), so a conversation survives a crash and a write is never sent twice.

The [architecture overview](docs/architecture/overview.md) explains how the parts fit together.

## Start Cerebro

You need Docker, pnpm 11, and an [OpenRouter](https://openrouter.ai/keys) API key. The stack runs in Docker Compose: PostgreSQL, two MinIO stores, the API on celld, and the web app.

1. Copy the example settings:

   ```sh
   cp .env.example .env
   ```

2. In `.env`, set `CEREBRO_MODEL_API_KEY` to your OpenRouter key.
3. Start the stack:

   ```sh
   pnpm start
   ```

The first start builds the images and takes a few minutes. When it finishes, it prints the web URL and a setup token:

```text
Cerebro is running at http://localhost:3001
Setup token: <token>
```

Open http://localhost:3001, sign up, and enter the setup token. You are now the owner. Create an agent, start a conversation, and send a message.

## Change the model

The default model is GPT-6 Luna on OpenRouter (`openrouter/openai/gpt-6-luna`). Cerebro works with any OpenAI-compatible endpoint.

- To use another OpenRouter model, set `CEREBRO_MODEL` to `openrouter/` followed by the OpenRouter model ID, for example `openrouter/openai/gpt-6-sol`.
- To use another endpoint, set `CEREBRO_MODEL`, `CEREBRO_MODEL_BASE_URL`, and `CEREBRO_MODEL_API_KEY`. For a model on your machine, such as Ollama, use `http://host.docker.internal:11434/v1` and leave the key empty.

`pnpm start` writes the model settings into `runtime.json` on every start. After you edit `.env`, run `pnpm start` again. Existing agents keep their old model until you select the new one in the agent editor.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm start` | Builds and starts the stack, then prints the URL and setup token. |
| `pnpm stop` | Stops the stack. Data stays in Docker volumes. |
| `pnpm token` | Prints the setup token. |
| `pnpm logs` | Follows the logs. Add service names to filter, for example `pnpm logs celld`. |

To delete all local data, run `docker compose -p cerebro down --volumes`.

The web app is on port `3001` and the API on port `18765`. To use other ports, set `CEREBRO_WEB_PORT`, `CEREBRO_API_PORT`, `CEREBRO_PUBLIC_WEB_URL`, and `CEREBRO_PUBLIC_API_URL` in `.env`.

## Run the checks

Install dependencies once with `pnpm install --frozen-lockfile`. Every check except `check-types`, `check`, `check:react`, `verify:commit`, `build`, `test:contracts`, and `test:identity` needs Docker.

| Command | Covers |
| --- | --- |
| `pnpm check-types` | TypeScript across the workspace |
| `pnpm check` | Lint and formatting |
| `pnpm check:react` | React Doctor for the web app and shared UI |
| `pnpm verify:commit` | Ultracite and React Doctor, as run by the commit hook |
| `pnpm build` | Production build of every package |
| `pnpm test:contracts` | Shared contracts and session schemas |
| `pnpm test:identity` | Identity, OIDC, and SCIM |
| `pnpm test:policy` | Tool authority, approvals, and the tool gateway |
| `pnpm test:memory` | Company memory and retrieval |
| `pnpm test:channels` | Web and Slack channels against PostgreSQL |
| `pnpm test:runtime` | The Pi session host on celld, including crash recovery. Takes about 15 minutes. |
| `pnpm test:channels:native` | Channels against a full stack |
| `pnpm test:integration` | Full stacks: boot, the pilot acceptance gates, and backup restore |

Integration tests start isolated stacks with `tests/slice-1/compose.test.yaml`, which adds the fake model and connectors. `pnpm test:pi:live` runs one check against a real model and connector; [its README](tests/live/README.md) lists what it needs.

After `pnpm install`, Husky runs both checks before each local commit. Ultracite checks the workspace; React Doctor checks the web app and shared UI. The checks read working files, including unstaged changes. Errors block the commit; React Doctor warnings do not. The hook does not change or stage files. Fix reported errors, stage your changes, then retry the commit. React Doctor runs without network checks or score uploads. Run `pnpm verify:commit` to use the same checks manually. Git's `--no-verify` option can bypass this local hook.

## Learn more

- [How Cerebro fits together](docs/architecture/overview.md)
- [How to run Cerebro in production](docs/operations/production.md)
- [How to connect Slack](docs/operations/slack.md)
- [How to back up and restore a stack](docs/operations/backup.md)
- [Runtime configuration reference](docs/reference/runtime-configuration.md)
