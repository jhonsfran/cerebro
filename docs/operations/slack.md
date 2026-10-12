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

1. Slack sends the event. Cerebro verifies its signature, answers Slack right away, and does the work after the response, so Slack does not retry it. A retried event is safe: each event is admitted once.
2. The conversation's session posts **Working on it…** in the thread, then edits that message into the answer. Sources appear under the answer.
3. When a tool needs approval, the session posts the request with **Approve** and **Deny** buttons. A button press decides the approval as the linked person, with the same permission checks as the web app. The message then shows the decision.

The session keeps its own record of what it posted, so a crash or a repeated commit edits the existing message instead of posting a new one. Slack replies that were possibly delivered are never posted twice. When Slack rate limits a post, the session tries again a few seconds later.
