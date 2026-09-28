import { createServer } from "node:http";

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 1_048_576) {
        throw new Error("Fixture request exceeds one MiB");
      }
      chunks.push(chunk);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    if (
      !body ||
      typeof body !== "object" ||
      !("messages" in body) ||
      !Array.isArray(body.messages)
    ) {
      response.writeHead(400).end();
      return;
    }
    const lastUser = body.messages.findLastIndex((message: unknown) =>
      Boolean(
        message &&
        typeof message === "object" &&
        "role" in message &&
        message.role === "user"
      )
    );
    const completed = body.messages
      .slice(lastUser + 1)
      .some((message: unknown) =>
        Boolean(
          message &&
          typeof message === "object" &&
          "role" in message &&
          message.role === "tool"
        )
      );
    const delta = completed
      ? { content: "Cerebro fixture completed.", role: "assistant" }
      : {
          content: null,
          role: "assistant",
          tool_calls: [
            {
              function: { arguments: "{}", name: "fixture_probe" },
              id: "call_fixture_probe",
              index: 0,
              type: "function",
            },
          ],
        };
    const base = { created: 1, id: "chatcmpl_fixture", model: "deterministic" };
    if ("stream" in body && body.stream === true) {
      response.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
      });
      response.write(
        `data: ${JSON.stringify({ ...base, choices: [{ delta, finish_reason: null, index: 0 }], object: "chat.completion.chunk" })}\n\n`
      );
      response.write(
        `data: ${JSON.stringify({ ...base, choices: [{ delta: {}, finish_reason: completed ? "stop" : "tool_calls", index: 0 }], object: "chat.completion.chunk", usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 } })}\n\n`
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ...base,
        choices: [
          {
            finish_reason: completed ? "stop" : "tool_calls",
            index: 0,
            message: delta,
          },
        ],
        object: "chat.completion",
        usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
      })
    );
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Fixture failed",
      })
    );
  }
});

server.listen(8090, "0.0.0.0");
