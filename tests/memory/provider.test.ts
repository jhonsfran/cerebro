import { expect, test } from "bun:test";

import {
  createDeterministicFixtureEmbeddings,
  createHttpEmbeddings,
} from "../../packages/memory/src/index.ts";

const httpProvider = (endpoint: string) =>
  createHttpEmbeddings({
    apiKey: "test-key",
    dimensions: 2,
    endpoint,
    model: "real-model",
  });

test("HTTP embeddings validate model, dimensions, count, indices, finite vectors, and request shape", async () => {
  let responseBody: unknown = {
    data: [
      { embedding: [0, 1], index: 1 },
      { embedding: [1, 0], index: 0 },
    ],
    model: "real-model",
  };
  let requestBody: unknown;
  let authorization: string | null = null;
  const server = Bun.serve({
    async fetch(request) {
      requestBody = await request.json();
      authorization = request.headers.get("authorization");
      return Response.json(responseBody);
    },
    port: 0,
  });
  try {
    const provider = httpProvider(server.url.toString());
    expect(
      await provider.embed(["first", "second"], {
        deadlineAt: Date.now() + 1000,
      })
    ).toEqual({
      status: "ok",
      value: [
        [1, 0],
        [0, 1],
      ],
    });
    expect(requestBody).toEqual({
      dimensions: 2,
      input: ["first", "second"],
      model: "real-model",
    });
    expect(authorization).toBe("Bearer test-key");
    const invalidResponses = [
      [],
      [{ embedding: [1], index: 0 }],
      [{ embedding: [0, 0], index: 0 }],
      [{ embedding: [1, 0], index: 1 }],
      [{ embedding: [1, "NaN"], index: 0 }],
    ];
    await Promise.all(
      invalidResponses.map(async (data) => {
        const invalidServer = Bun.serve({
          fetch: () => Response.json({ data, model: "real-model" }),
          port: 0,
        });
        try {
          const invalidProvider = httpProvider(invalidServer.url.toString());
          const result = await invalidProvider.embed(["one"], {
            deadlineAt: Date.now() + 1000,
          });
          expect(result.status).toBe("unavailable");
        } finally {
          await invalidServer.stop(true);
        }
      })
    );
    responseBody = {
      data: [{ embedding: [1, 0], index: 0 }],
      model: "wrong-model",
    };
    const resolved2 = await provider.embed(["one"], {
      deadlineAt: Date.now() + 1000,
    });
    expect(resolved2.status).toBe("unavailable");
  } finally {
    await server.stop(true);
  }
});

test("HTTP embedding deadlines and cancellation include delayed response bodies", async () => {
  const server = Bun.serve({
    fetch() {
      let timer: ReturnType<typeof setTimeout>;
      return new Response(
        new ReadableStream({
          cancel() {
            clearTimeout(timer);
          },
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":'));
            timer = setTimeout(() => {
              controller.enqueue(
                new TextEncoder().encode('[{"index":0,"embedding":[1,0]}]}')
              );
              controller.close();
            }, 250);
          },
        }),
        { headers: { "content-type": "application/json" } }
      );
    },
    port: 0,
  });
  try {
    const provider = httpProvider(server.url.toString());
    const started = Date.now();
    const result = await provider.embed(["one"], { deadlineAt: started + 40 });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") {
      throw new Error("Provider did not enforce its deadline.");
    }
    expect(result.code).toBe("deadline-exceeded");
    expect(Date.now() - started).toBeLessThan(200);
    const controller = new AbortController();
    const request = provider.embed(["one"], {
      deadlineAt: Date.now() + 1000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    const cancelled = await request;
    expect(cancelled.status).toBe("unavailable");
    if (cancelled.status !== "unavailable") {
      throw new Error("Provider did not observe cancellation.");
    }
    expect(cancelled.code).toBe("cancelled");
  } finally {
    await server.stop(true);
  }
});

test("fixture embeddings are explicitly synthetic and reject invalid dimensions", async () => {
  expect(() => createDeterministicFixtureEmbeddings(0)).toThrow(
    "positive integer"
  );
  const fixture = createDeterministicFixtureEmbeddings(2);
  const result = await fixture.embed(["billing"], {
    deadlineAt: Date.now() + 1000,
  });
  expect(result).toEqual({ status: "ok", value: [[0.01, 1.01]] });
  expect(fixture.model).toBe("synthetic-fixture-2");
});
