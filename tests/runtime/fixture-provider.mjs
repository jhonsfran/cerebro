import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createFixture } from "../slice-1/provider.mjs";

const directory =
  process.env.FIXTURE_DATA_DIR ?? "/tmp/cerebro-native-host-provider";
const fixture = await createFixture({
  directory,
  fixtureId: process.env.FIXTURE_ID ?? "native-host",
  sha: process.env.FIXTURE_SHA ?? "dirty-checkout",
});
const filename = path.join(directory, "capabilities.json");
let observations = { model: [] };
try {
  observations = JSON.parse(await readFile(filename, "utf-8"));
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}
let writes = Promise.resolve();
const save = () => {
  const bytes = JSON.stringify(observations);
  const previous = writes;
  writes = (async () => {
    await previous;
    await writeFile(`${filename}.tmp`, bytes, { flush: true, mode: 0o600 });
    await rename(`${filename}.tmp`, filename);
  })();
  return writes;
};
const text = (message) =>
  typeof message?.content === "string"
    ? message.content
    : (message?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
};
const chooseResponse = (input) => {
  const names = (input.tools ?? []).map((item) => item.function.name);
  const lastUser = input.messages.findLastIndex(
    (message) => message.role === "user"
  );
  const prompt = text(input.messages[lastUser]);
  const result = input.messages
    .slice(lastUser + 1)
    .findLast((message) => message.role === "tool");
  if (names.length === 0) {
    return {
      content: "Fixture compacted capability history.",
      purpose: "compaction",
    };
  }
  if (result) {
    return {
      content: names.includes("subagent")
        ? `CAP_PARENT_COMPLETED ${text(result)}`
        : `CAP_CHILD_COMPLETED ${text(result)}`,
      purpose: "turn",
    };
  }
  if (names.includes("search_conversations")) {
    return {
      arguments: {
        term:
          /CAP_HISTORY (?<term>[A-Za-z0-9_-]+)/u.exec(prompt)?.groups?.term ??
          "CAP_SEARCH_TOKEN",
      },
      name: "search_conversations",
      purpose: "turn",
    };
  }
  if (prompt.startsWith("CAP_DELEGATE") && names.includes("subagent")) {
    return {
      arguments: { task: "CAP_CHILD_APPLY fixture_effect once." },
      name: "subagent",
      purpose: "turn",
    };
  }
  if (
    prompt.startsWith("CAP_CHILD_APPLY") &&
    names.includes("fixture_effect")
  ) {
    return {
      arguments: { value: "delegated-fixture" },
      name: "fixture_effect",
      purpose: "turn",
    };
  }
  if (prompt.startsWith("CAP_HISTORY") && names.includes("search_history")) {
    return {
      arguments: { question: prompt },
      name: "search_history",
      purpose: "turn",
    };
  }
  if (prompt.startsWith("CAP_SCHEDULE") && names.includes("schedule")) {
    return {
      arguments: { delaySeconds: 30, instruction: "CAP_REMINDER_TOOL_DUE" },
      name: "schedule",
      purpose: "turn",
    };
  }
  return { content: "CAP_ACK", purpose: "turn" };
};
const capabilityModel = async (request, response) => {
  if (request.headers.authorization !== "Bearer fixture-model-key") {
    response.writeHead(401);
    response.end();
    return;
  }
  const input = await readBody(request);
  const selected = chooseResponse(input);
  const operationId = String(request.headers["x-fixture-request-id"]);
  const scope = String(request.headers["x-fixture-public-session"]);
  const prompt = text(
    input.messages.findLast((message) => message.role === "user")
  );
  const call = {
    operationId,
    prompt,
    purpose: selected.purpose,
    scope,
    startedAt: Date.now(),
    toolNames: (input.tools ?? []).map((tool) => tool.function.name),
  };
  observations.model.push(call);
  await save();
  const callId = createHash("sha256")
    .update(JSON.stringify({ operationId, prompt, scope }))
    .digest("hex")
    .slice(0, 24);
  const message = selected.name
    ? {
        content: null,
        role: "assistant",
        tool_calls: [
          {
            function: {
              arguments: JSON.stringify(selected.arguments),
              name: selected.name,
            },
            id: `call_${callId}`,
            type: "function",
          },
        ],
      }
    : { content: selected.content, role: "assistant" };
  const base = { created: 1, id: `chatcmpl_${callId}`, model: input.model };
  const { controls } = JSON.parse(
    await readFile(path.join(directory, "committed.json"), "utf-8")
  );
  const usage = { completion_tokens: 4, prompt_tokens: 8, total_tokens: 12 };
  if (input.stream) {
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Type": "text/event-stream",
    });
    await delay(controls.delayMs);
    if (response.destroyed) {
      return;
    }
    const delta = selected.name
      ? {
          ...message,
          tool_calls: message.tool_calls.map((tool) => ({ ...tool, index: 0 })),
        }
      : message;
    response.write(
      `data: ${JSON.stringify({ ...base, choices: [{ delta, finish_reason: null, index: 0 }], object: "chat.completion.chunk" })}\n\n`
    );
    call.completedAt = Date.now();
    await save();
    response.end(
      `data: ${JSON.stringify({ ...base, choices: [{ delta: {}, finish_reason: selected.name ? "tool_calls" : "stop", index: 0 }], object: "chat.completion.chunk", usage })}\n\ndata: [DONE]\n\n`
    );
  } else {
    await delay(controls.delayMs);
    call.completedAt = Date.now();
    await save();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ...base,
        choices: [
          {
            finish_reason: selected.name ? "tool_calls" : "stop",
            index: 0,
            message,
          },
        ],
        object: "chat.completion",
        usage,
      })
    );
  }
};
const [baseHandler] = fixture.server.listeners("request");
fixture.server.removeAllListeners("request");
fixture.server.on("request", async (request, response) => {
  try {
    if (
      request.method === "GET" &&
      request.url === "/capabilities/observations"
    ) {
      await writes;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(observations));
    } else if (
      request.method === "POST" &&
      request.url === "/v1/chat/completions" &&
      request.headers["x-fixture-capabilities"] === "1"
    ) {
      await capabilityModel(request, response);
    } else {
      await baseHandler(request, response);
    }
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
    } else {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
  }
});
fixture.server.listen(
  Number(process.env.FIXTURE_PORT ?? 8090),
  "0.0.0.0",
  () => {
    process.send?.({ port: fixture.server.address().port });
  }
);
