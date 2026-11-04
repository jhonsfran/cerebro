# How to connect Slack

People can talk to one Cerebro agent in a Slack direct message. Each top-level message starts a conversation, and replies in its thread continue it. Answers, progress, and approval buttons appear in the same thread. Cerebro checks the person's current permissions before it posts anything, exactly as it does in the web app.

Answers only go to direct messages. If someone mentions the app in a channel, Cerebro tells only that person, in a message the others cannot see, to send a DM instead. That keeps company content out of shared channels.

## Create the Slack app

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) in your workspace.
2. Under **OAuth & Permissions**, add these bot token scopes:
   - `chat:write`, to post and edit replies.
   - `im:history`, to receive direct messages.
   - `app_mentions:read`, to answer a channel mention with the DM hint.
3. Under **App Home**, turn on **Allow users to send Slash commands and messages from the messages tab**.
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

1. Cerebro verifies the signature, workspace, and app. It saves an accepted event to the durable event queue before it acknowledges Slack. A queue failure gets an unsuccessful response so Slack can retry. URL verification returns its challenge after signature validation.
2. The consumer checks the event type and account link. It saves either an ignored decision or a fixed conversation target under the provider event ID. A retry keeps that decision. Current access is checked again before execution and disclosure.
3. The conversation's session posts **Working on it…** in the thread, then edits that message into the answer. Sources appear under the answer.
4. When a tool needs approval, the session posts the request with **Approve** and **Deny** buttons. A button press decides the approval as the linked person, with the same permission checks as the web app. The message then shows the decision.

The session journals Slack writes. It edits a known message on replay. If a post's delivery is uncertain, it does not blindly repeat the post. This prevents duplicate retries but can leave an uncertain reply undelivered. A known rate-limit response can be retried after the delay.

## Enable background teams

Publish coordinator, lead, and worker agents with the models and grants each role needs. Set `channels.json`'s `agentId` to the coordinator. Add the optional [coordination profile](../reference/runtime-configuration.md#coordination) to `runtime.json`, then run bootstrap again.

The coordinator gets `start_team`, `get_work`, `message_team`, and `stop_work`. The lead gets `delegate_worker`. Team tools are read-only. The source conversation delivers the result to the original Slack thread.

In a thread with active work, further messages go directly to that team. The exact lowercase messages `status` and `stop` are controls. They do not call the coordinator model. A later request can start new work after the previous team has settled.

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
