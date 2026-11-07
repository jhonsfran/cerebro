# Run a persistent coordinator and private teams

Open one persistent conversation with an agent. It can start private Teams whose lead and workers act as that same agent. Results return to the same conversation. Web chat works before Slack is configured.

```mermaid
flowchart LR
  Web[Web chat] --> C[Persistent coordinator]
  Slack[Filtered Slack events] --> C
  C --> A[Private Team A]
  C --> B[Private Team B]
  A --> C
  B --> C
```

The identity cell stores the coordinator and admission records. Each Team has its own cell. Its lead is a private Pi conversation inside that cell, and each worker is a child conversation of the lead. Always on means saved state and event-driven wake-up. An idle agent makes no model requests.

## Configure the agent

1. Configure the model endpoint and key, then start Cerebro. See [Start Cerebro](../../README.md#start-cerebro). For a separate local test installation, use the recipe below.
2. Create and save one agent in the web editor. Its model must support tool calls. For the first test, use these instructions: "For a request to start a team, call `start_team` with the complete goal. Acknowledge that work is running."
3. Open the agent's conversation. Team tools are available as soon as the agent is published. No agent IDs, profile, or restart are needed.

A Team runs as the agent you selected. Its roles derive from that agent's definition:

| Role | Model and grants | Instructions |
| --- | --- | --- |
| Lead | The agent's model, enabled tools, and grants | A system overlay to split the goal and call `delegate_worker` once per question, several in the same turn, followed by the agent's instructions. |
| Worker | The agent's model, enabled tools, and grants | A system overlay to answer one assigned question without delegating, followed by the agent's instructions. |

Each `delegate_worker` call starts a worker in a new private child conversation. Calls in the same turn run in parallel, up to the team's worker limit. A call beyond the limit returns an error that tells the lead to wait for running workers. A role never holds more than the agent. Its tools are limited to read-only tools that need no approval. A Team cannot request approval, and routing an approval to the coordinator is out of scope. The first test needs no external tools or company sources. Add explicit grants to the agent before Teams handle company content.

## Set team limits

Each Team runs under three budgets: workers at once, model calls shared by the lead and every worker, and a time limit. The installation sets defaults. To change them, add an optional `coordination` block to `runtime.json`. It carries limits only. See the [runtime reference](../reference/runtime-configuration.md#coordination).

An agent can override any budget. In the agent editor, open **Teams** and set **Workers at once**, **Model calls per team**, or **Time limit in seconds**. Leave a field empty to use the installation default. Each save publishes a new agent version. Running Teams keep the budgets saved at admission. A value outside the safety bounds fails to publish. The number of active Teams stays an installation setting.

## Send and control a team request

Select the coordinator agent and open its conversation. Reopening the same agent returns to the same primary chat. Send:

> Start a team. Compare SQLite and PostgreSQL for a local task tracker. Ask one worker to assess each option, then give me a recommendation and its tradeoff.

Require the coordinator's acknowledgement, a background-work status, and a later result in the same conversation. The composer remains available while the team runs. Reload that conversation and require the saved result to remain.

While work is active, send exact lowercase `status` to read saved work state without a model call. Exact `stop` returns the work IDs to choose from. Ask the coordinator to stop one work ID. The foreground **Stop** button stops the current coordinator turn and leaves private Teams running.

Ordinary new text reaches the coordinator. It can answer, start independent work, or message an existing work ID. State the target when you add a requirement. For example, send "For storage work <work ID>, add a two-device offline conflict requirement." Automatic routing applies only to an explicit saved subscription.

Two Teams can run for one person across their agents. Sixteen more can wait in a saved FIFO queue. The absolute deadline includes queue time. Cancelling a queued item creates no Team cell.

In a local installation, the development Inspector opens inside the chat. Select a work item to inspect its lead, workers, saved models, safe tool activity, retry state, reservations, tokens, and result. Details load on demand. Completed work remains available after reload. Inspection checks current read access and admits no new model work. A cold active cell can resume an already accepted request during normal recovery. Repeated reads of a sealed Team add no model requests. Configured zero prices make monetary cost unavailable. Request reservations and provider token usage are separate values.

A published agent definition applies at a safe turn boundary in the same chat. Existing Teams keep the agent version pinned at admission.

If command delivery is uncertain, work can show **Failed** while cancellation is still available. Stop sends a durable cancellation request. Current permissions and the deadline still apply.

A model can answer directly instead of starting a team. Check the actual `start_team` activity and provider request logs when you test model selection. Use the Inspector to check the saved private role state. Full provider reasoning, system instructions, credentials, and raw tool arguments are excluded.

## Use a separate local configuration

The default local starter generates one model configuration on each start. To maintain custom models or team limits, use a private host directory and an explicit Compose override. This recipe creates a separate project and data volumes.

Run these commands from the repository root after you configure the model key in `.env`:

```sh
export CEREBRO_TEAM_SECRETS_DIR="$HOME/.config/cerebro/teams-test/secrets"
export CEREBRO_DEPLOY_MODE=local
export CEREBRO_DATABASE_URL=
export CEREBRO_API_PORT=18766
export CEREBRO_WEB_PORT=3002
export CEREBRO_PUBLIC_API_URL=http://127.0.0.1:18766
export CEREBRO_PUBLIC_WEB_URL=http://127.0.0.1:3002
rtk proxy mkdir -p "$CEREBRO_TEAM_SECRETS_DIR"
rtk proxy chmod 700 "$HOME/.config/cerebro/teams-test" "$CEREBRO_TEAM_SECRETS_DIR"
```

Save this as `$HOME/.config/cerebro/teams-test/compose.yaml`:

```yaml
services:
  secrets-init:
    volumes:
      - ${CEREBRO_TEAM_SECRETS_DIR:?Set CEREBRO_TEAM_SECRETS_DIR}:/run/cerebro-secrets
  bootstrap:
    volumes:
      - ${CEREBRO_TEAM_SECRETS_DIR:?Set CEREBRO_TEAM_SECRETS_DIR}:/run/cerebro-secrets:ro
```

Start the separate installation. The first start generates its full runtime file and storage secrets:

```sh
rtk proxy docker compose -p cerebro-teams -f compose.yaml -f "$HOME/.config/cerebro/teams-test/compose.yaml" up --build -d --wait
```

Read this installation's setup token, then open `http://127.0.0.1:3002`, sign up with a test account, and claim the workspace:

```sh
rtk proxy docker compose -p cerebro-teams -f compose.yaml -f "$HOME/.config/cerebro/teams-test/compose.yaml" run --rm --no-deps bootstrap node --input-type=module -e 'import {readFile} from "node:fs/promises";process.stdout.write(await readFile("/run/cerebro-secrets/bootstrap-token","utf8"))'
```

Edit `$CEREBRO_TEAM_SECRETS_DIR/runtime.json` to configure models and optional team limits. To add another model on the same provider, copy the generated model object and change its `model` and `id`. Its ID must remain `<provider>/<model>`. Use separate endpoint and credential values if the second model needs them.

After the first start, add this environment property to `secrets-init` in the override, alongside its volumes:

```yaml
environment:
  CEREBRO_MODEL: ""
```

An unset or empty host variable is insufficient because the base Compose file supplies a default. Keep this override on future starts. Use the Compose commands in this recipe; `pnpm start` selects only the base file.

After each runtime edit, wait for bootstrap to finish before restarting celld:

```sh
rtk proxy docker compose -p cerebro-teams -f compose.yaml -f "$HOME/.config/cerebro/teams-test/compose.yaml" run --rm --no-deps bootstrap
rtk proxy docker compose -p cerebro-teams -f compose.yaml -f "$HOME/.config/cerebro/teams-test/compose.yaml" restart celld
```

`up --wait bootstrap` can report the one-shot service running before its deployment finishes. The synchronous `run` above waits for the process exit.

To stop this test installation and retain its data:

```sh
rtk proxy docker compose -p cerebro-teams -f compose.yaml -f "$HOME/.config/cerebro/teams-test/compose.yaml" stop
```

The [coordinator diagram](../architecture/slack-coordinator.md) explains source routing and recovery. The [runtime reference](../reference/runtime-configuration.md#coordination) defines limits. Slack can be added later through its [channel setup](slack.md).
