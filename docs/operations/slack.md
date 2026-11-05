# How to connect Slack

Slack direct messages are events for a person's persistent agent. They use the same coordinator conversation as web chat. A Slack thread is a reply destination and can have explicit work subscriptions. It does not create another coordinator. Cerebro checks current account links, source access, and content access before each reply.

Answers only go to direct messages. If someone mentions the app in a channel, Cerebro tells only that person, in a message the others cannot see, to send a DM instead. That keeps company content out of shared channels.

## Create the Slack app

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) in your workspace.
2. Under **OAuth & Permissions**, add these bot token scopes:
   - `chat:write`, to post and edit replies.
   - `im:history`, to receive direct messages.
   - `app_mentions:read`, to answer a channel mention with the DM hint.
3. Under **App Home**, enable the **Messages Tab** in **Show Tabs**. See [Slack's App Home setup](https://docs.slack.dev/surfaces/app-home/).
4. Under **Event Subscriptions**, set the request URL to `https://<API_HOST>/api/channels/slack/events` and subscribe to the bot events `message.im` and `app_mention`. Slack verifies the URL when you save it, so the stack must be running.
5. Under **Interactivity & Shortcuts**, turn interactivity on and set the request URL to `https://<API_HOST>/api/channels/slack/interactions`. The Approve and Deny buttons post here.
6. Install the app to the workspace and copy the **Bot User OAuth Token**.

## Configure Cerebro

Add `channels.json` to the secrets directory:

```json
{
  "organizationId": "<ORGANIZATION_ID>",
  "slack": {
    "workspaceId": "<SLACK_TEAM_ID>",
    "appId": "<SLACK_APP_ID>",
    "agentId": "<CEREBRO_AGENT_ID>",
    "signingSecret": "<SLACK_SIGNING_SECRET>",
    "botToken": "<SLACK_BOT_TOKEN>"
  }
}
```

| Field | Notes |
| --- | --- |
| `workspaceId` | The Slack team ID. Events from any other workspace are rejected. |
| `appId` | The Slack app ID. Events for any other app are rejected. |
| `agentId` | The agent that answers in Slack. Copy it from the agent editor. |
| `signingSecret` | Verifies that each request comes from Slack. |
| `botToken` | Posts and edits replies. Without it, Cerebro accepts messages but posts nothing. |
| `apiUrl` | Local mode only. Points the Slack Web API at a test double. |

Start the stack again to apply the file. Keep the signing secret and the bot token in your secret store, and rotate them in Slack if they are exposed.

## Link a Slack account

A Slack user must link their account once before Cerebro answers them:

1. In the web app, choose **Link your Slack account**. Cerebro shows a one-time code.
2. Send `link <code>` to the app in a direct message.

Cerebro confirms the link in the DM. An unlinked person who writes to the app gets a reply that explains these steps. Removing the link stops every later reply, even in an open thread.

## What happens to a message

1. Cerebro verifies the [Slack request signature](https://docs.slack.dev/authentication/verifying-requests-from-slack/), workspace, and app. It saves an accepted event to the durable event queue before it acknowledges Slack. A queue failure gets an unsuccessful response so Slack can retry. URL verification returns its challenge after signature validation.
2. The consumer filters bot messages, unsupported events, and unlinked users. An accepted message saves its owner and fixed target bots under the provider event ID. Explicit subscriptions can select several owned bots. Otherwise, the configured agent is the target. A retry reuses that decision. Changed content conflicts.
3. Each target primary admits one owned event. Ordinary text reaches the coordinator. A follow-up with an explicit work subscription goes to that Team. An unrelated subscribed event can return to the coordinator once.
4. The coordinator's exact settled answer creates a durable reply intent for the original thread. Concurrent web answers cannot become Slack replies. Current access is checked again before delivery.

The reply task saves an unknown outcome and synchronizes storage before posting. Confirmed success saves its Slack timestamp. An uncertain post does not send again automatically. This can leave a reply undelivered when Slack did not receive the original attempt. A known rate-limit response can retry after its saved delay. Historical Slack sessions retain their saved progress messages and approval handling.

## Enable background teams

The same coordinator and team runtime also supports [ordinary web chat](agent-teams.md). Slack adds event intake, account linking, and replies to the original DM thread.

Publish coordinator, lead, and worker agents with the models and grants each role needs. Set `channels.json`'s `agentId` to the coordinator. Add the optional [coordination profile](../reference/runtime-configuration.md#coordination) to `runtime.json`, then run bootstrap again.

The coordinator gets `start_team`, `get_work`, `message_team`, `stop_work`, `list_work`, `recall_work`, `subscribe_work`, and `unsubscribe_work`. The lead gets `delegate_worker` and `return_event`. Team connector tools are read-only. A report enters the coordinator as an internal event. It grants no new Slack destination. If the work retains an authorized Slack origin, the coordinator's answer can return only to that original thread.

Ordinary messages can start independent work while other Teams run. Only explicit subscriptions forward thread events directly. The exact lowercase `status` reads saved work without a model call. Exact `stop` lists work IDs when a target is needed. Ask the coordinator to stop a specific work ID. Two Teams can run and sixteen can wait for one person across their agents.

The web development Inspector shows saved event decisions, work, private roles, model IDs, usage, and results. It requires current read access. Opening it does not admit work. An idle coordinator makes no model requests.

See the [cell diagram and code](../architecture/slack-coordinator.md) for placement, limits, and recovery.

## Inspect and replay failed events

Run the queue wrapper inside the installation's `celld` container. Use the same Compose project, environment, and files as deployment. For the production configuration in [the deployment guide](production.md):

```sh
docker compose -f compose.yaml -f compose.production.yaml exec -T celld \
  node /app/deploy/queues.mjs info cerebro-slack-events-dead-letter

docker compose -f compose.yaml -f compose.production.yaml exec -T celld \
  node /app/deploy/queues.mjs peek cerebro-slack-events-dead-letter --limit 5

docker compose -f compose.yaml -f compose.production.yaml exec -T celld \
  node /app/deploy/queues.mjs redrive cerebro-slack-events-dead-letter --limit 5
```

Inspect the failure and fix its cause before redrive. The wrapper loads fleet credentials from the mounted secrets directory. Its output can contain message text, so restrict it to operators.

| Source queue            | Dead-letter queue                   |
| ----------------------- | ----------------------------------- |
| `cerebro-slack-events`  | `cerebro-slack-events-dead-letter`  |
| `cerebro-team-commands` | `cerebro-team-commands-dead-letter` |
| `cerebro-team-reports`  | `cerebro-team-reports-dead-letter`  |

Dead-letter queues have no application consumer. `info` and `peek` work on all six queues. `redrive` accepts only a dead-letter queue and requires an explicit limit from 1 to 100. It returns messages to their source queue with their original application event, command, or report IDs. Duplicate delivery does not create new logical work. Previously ignored Slack events stay ignored.
