// Slack mrkdwn uses one asterisk for bold and <url|label> for links.
// Slack truncates messages longer than 40,000 characters.
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
