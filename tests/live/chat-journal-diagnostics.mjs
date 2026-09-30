/* oxlint-disable no-await-in-loop -- Inspect each local SQLite journal without printing request or response content. */
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const summarize = (record) => {
  const receipt = record.result?.value;
  let contentCharacters = 0;
  let reasoningCharacters = 0;
  const finishReasons = new Set();
  for (const line of (receipt?.body ?? "").split(/\r?\n/u)) {
    if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") {
      continue;
    }
    const frame = JSON.parse(line.slice(5));
    for (const choice of frame.choices ?? []) {
      const delta = choice.delta ?? choice.message;
      if (typeof delta?.content === "string") {
        contentCharacters += delta.content.length;
      }
      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (typeof reasoning === "string") {
        reasoningCharacters += reasoning.length;
      }
      if (
        ["stop", "length", "tool_calls", "content_filter"].includes(
          choice.finish_reason
        )
      ) {
        finishReasons.add(choice.finish_reason);
      }
    }
  }
  return {
    contentCharacters,
    finishReasons: [...finishReasons],
    inputTokens: receipt?.inputTokens,
    outputTokens: receipt?.outputTokens,
    reason: record.reason,
    reasoningCharacters,
    state: record.state,
    status: record.result?.status,
  };
};

for (const entry of await readdir("/var/lib/celld", {
  recursive: true,
  withFileTypes: true,
})) {
  if (!entry.isFile()) {
    continue;
  }
  const filename = path.join(entry.parentPath, entry.name);
  const file = await open(filename, "r");
  const header = Buffer.alloc(16);
  await file.read(header, 0, 16, 0);
  await file.close();
  if (header.toString() !== "SQLite format 3\0") {
    continue;
  }
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    if (
      !database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='cerebro_operation'"
        )
        .get()
    ) {
      continue;
    }
    const records = database
      .prepare(
        "SELECT result FROM cerebro_operation WHERE id LIKE 'journal:%' AND json_valid(result) AND json_extract(result,'$.namespace')='model'"
      )
      .all();
    for (const row of records) {
      process.stdout.write(
        `${JSON.stringify(summarize(JSON.parse(row.result)))}\n`
      );
    }
  } finally {
    database.close();
  }
}
