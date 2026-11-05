import assert from "node:assert/strict";
import { test } from "node:test";

import { toSlackText } from "../../packages/contracts/src/slack-text.ts";

test("Slack text uses canonical mrkdwn and the existing character cap", () => {
  assert.equal(
    toSlackText("# Result\n**Done** [details](https://example.com/result)"),
    "*Result*\n*Done* <https://example.com/result|details>"
  );
  assert.equal(toSlackText("x".repeat(40_001)), `${"x".repeat(39_000)}…`);
});
