# Cerebro

Cerebro is a self-hosted assistant for a company. People chat with agents that answer from company memory, call controlled tools, and ask for approval before they write anything. Every step checks the person's current permissions. Agents run on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable), so a conversation survives a crash and a write is never sent twice.

The [architecture overview](docs/architecture/overview.md) explains how the parts fit together.

## Start Cerebro

You need Docker and pnpm 11. The stack runs in Docker Compose: PostgreSQL, two MinIO stores, the API on celld, and the web app.

### Try it without a model key

```sh
pnpm start:demo
```

The demo uses a fake model that always gives the same answer, so it needs no key. The first start builds the images and takes a few minutes. When it finishes, it prints the web URL and a setup token:

```text
Cerebro is running at http://localhost:3001
Setup token: <token>
```

Open http://localhost:3001, sign up, and enter the setup token. You are now the owner. Create an agent, start a conversation, and send a message.

### Use a real model

Cerebro works with any OpenAI-compatible endpoint.

1. Copy the example settings:

   ```sh
   cp .env.example .env
   ```

2. In `.env`, set `CEREBRO_MODEL`, `CEREBRO_MODEL_BASE_URL`, and `CEREBRO_MODEL_API_KEY`. For a model on your machine, such as Ollama, use `http://host.docker.internal:11434/v1` and leave the key empty.
3. Start the stack:

   ```sh
   pnpm start
   ```

`pnpm start` writes your model settings into `runtime.json` on every start. To change the model, edit `.env` and run `pnpm start` again. Existing agents keep their old model until you select the new one in the agent editor.

The demo and the real stack keep separate data. Stop one before you start the other, because they use the same ports.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm start` | Builds and starts the stack with the model from `.env`, then prints the URL and setup token. |
| `pnpm start:demo` | The same, with the fake model. |
| `pnpm stop` | Stops both stacks. Data stays in Docker volumes. |
| `pnpm token` | Prints the setup token. Add `--demo` for the demo stack. |
| `pnpm logs` | Follows the logs. Add service names to filter, for example `pnpm logs celld`. |

To delete all local data, run `docker compose -p cerebro down --volumes`. For the demo stack, run `docker compose -p cerebro-demo -f compose.yaml -f tests/slice-1/compose.test.yaml down --volumes`.

The web app is on port `3001` and the API on port `18765`. To use other ports, set `CEREBRO_WEB_PORT`, `CEREBRO_API_PORT`, `CEREBRO_PUBLIC_WEB_URL`, and `CEREBRO_PUBLIC_API_URL` before you start.

## Run the checks

Install dependencies once with `pnpm install --frozen-lockfile`. Every check except `check-types`, `check`, `build`, `test:contracts`, and `test:identity` needs Docker.

| Command | Covers |
| --- | --- |
| `pnpm check-types` | TypeScript across the workspace |
| `pnpm check` | Lint and formatting |
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

## Learn more

- [How Cerebro fits together](docs/architecture/overview.md)
- [Architecture decision: keep company rules independent of replaceable components](docs/architecture/adr-0001-replaceable-application-boundaries.md)
- [How to run Cerebro in production](docs/operations/production.md)
- [How to back up and restore a stack](docs/operations/backup.md)
- [Runtime configuration reference](docs/reference/runtime-configuration.md)
