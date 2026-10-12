import { z } from "zod";

import type { SlackConfiguration } from "./types";

const SLACK_API_URL = "https://slack.com/api";
const SLACK_TIMEOUT_MS = 10_000;

const slackResponse = z.object({
  channel: z.string().optional(),
  error: z.string().optional(),
  ok: z.boolean(),
  ts: z.string().optional(),
});

// "sent" proves delivery, "failed" proves Slack rejected the call, "retry"
// means Slack asked the caller to slow down, and "unknown" means the message
// may have been posted.
export type SlackResult =
  | { readonly state: "sent"; readonly ts: string }
  | { readonly state: "failed"; readonly error: string }
  | { readonly state: "retry" }
  | { readonly state: "unknown" };

export interface SlackBlock {
  readonly type: string;
  readonly [field: string]: unknown;
}
export interface SlackMessage {
  readonly channel: string;
  readonly text: string;
  readonly threadTs?: string;
  readonly blocks?: readonly SlackBlock[];
}

export interface SlackApi {
  readonly send: (message: SlackMessage) => Promise<SlackResult>;
  readonly edit: (
    message: SlackMessage & { readonly ts: string }
  ) => Promise<SlackResult>;
  readonly sendEphemeral: (
    message: SlackMessage & { readonly user: string }
  ) => Promise<SlackResult>;
}

// A test or local deployment may point apiUrl at a fake; older configurations
// named the chat.postMessage endpoint itself.
const baseUrl = (configuration: SlackConfiguration): string =>
  (configuration.apiUrl ?? SLACK_API_URL)
    .replace(/\/chat\.postMessage$/u, "")
    .replace(/\/$/u, "");

const message = (value: SlackMessage) => ({
  channel: value.channel,
  text: value.text,
  ...(value.threadTs ? { thread_ts: value.threadTs } : {}),
  ...(value.blocks ? { blocks: value.blocks } : {}),
});

export const createSlackApi = (
  configuration: SlackConfiguration,
  providerFetch: typeof fetch = fetch
): SlackApi => {
  const call = async (
    method: string,
    body: Record<string, unknown>
  ): Promise<SlackResult> => {
    if (!configuration.botToken) {
      return { error: "not_configured", state: "failed" };
    }
    try {
      const response = await providerFetch(
        `${baseUrl(configuration)}/${method}`,
        {
          body: JSON.stringify(body),
          headers: {
            Authorization: `Bearer ${configuration.botToken}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          method: "POST",
          signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
        }
      );
      if (response.status === 429) {
        await response.body?.cancel();
        return { state: "retry" };
      }
      const parsed = slackResponse.safeParse(await response.json());
      if (response.ok && parsed.success && parsed.data.ok) {
        return { state: "sent", ts: parsed.data.ts ?? "" };
      }
      if (
        parsed.success &&
        parsed.data.error &&
        parsed.data.error !== "fatal_error" &&
        response.status < 500
      ) {
        return { error: parsed.data.error, state: "failed" };
      }
      return { state: "unknown" };
    } catch {
      return { state: "unknown" };
    }
  };
  return {
    edit: (value) =>
      call("chat.update", {
        blocks: value.blocks ?? [],
        channel: value.channel,
        text: value.text,
        ts: value.ts,
      }),
    send: (value) => call("chat.postMessage", message(value)),
    sendEphemeral: (value) =>
      call("chat.postEphemeral", { ...message(value), user: value.user }),
  };
};

// Slack mrkdwn differs from Markdown: bold uses one asterisk and links use
// <url|label>. Slack rejects text longer than 40,000 characters.
const SLACK_TEXT_LIMIT = 39_000;
export const toSlackText = (markdown: string): string => {
  const converted = markdown
    .replaceAll(/\*\*(?<bold>[^*\n]+)\*\*/gu, "*$<bold>*")
    .replaceAll(/^#{1,6}\s+(?<heading>.+)$/gmu, "*$<heading>*")
    .replaceAll(
      /\[(?<label>[^\]\n]+)\]\((?<url>https?:\/\/[^\s)]+)\)/gu,
      "<$<url>|$<label>>"
    );
  return converted.length > SLACK_TEXT_LIMIT
    ? `${converted.slice(0, SLACK_TEXT_LIMIT)}…`
    : converted;
};
