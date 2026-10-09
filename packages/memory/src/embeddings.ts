import type { ReadOptions } from "@cerebro/contracts";

import { interrupted } from "./runtime";
import type { EmbeddingPort } from "./types";

export const validEmbedding = (
  value: unknown,
  dimensions: number
): value is number[] =>
  Array.isArray(value) &&
  value.length === dimensions &&
  value.every((item) => typeof item === "number" && Number.isFinite(item)) &&
  value.some((item) => item !== 0);

export const fetchWithDeadline = async (
  url: string | Request,
  init: RequestInit,
  options: ReadOptions
): Promise<Response> => {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(
    cancel,
    Math.max(0, Math.min(options.deadlineAt - Date.now(), 2_147_483_647))
  );
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) {
    cancel();
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.arrayBuffer();
    return new Response(
      response.status === 204 ||
        response.status === 205 ||
        response.status === 304
        ? null
        : body,
      {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      }
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
};

const parseEmbeddings = (
  body: unknown,
  model: string,
  dimensions: number,
  count: number
): readonly (readonly number[])[] => {
  if (
    !body ||
    typeof body !== "object" ||
    !("data" in body) ||
    !Array.isArray(body.data) ||
    body.data.length !== count ||
    ("model" in body && body.model !== model)
  ) {
    throw new Error("The embedding provider returned an invalid response.");
  }
  const vectors: (readonly number[])[] = Array.from({ length: count });
  const indices = new Set<number>();
  for (const row of body.data) {
    if (
      !row ||
      typeof row !== "object" ||
      !("index" in row) ||
      typeof row.index !== "number" ||
      !Number.isInteger(row.index) ||
      row.index < 0 ||
      row.index >= count ||
      indices.has(row.index) ||
      !("embedding" in row) ||
      !validEmbedding(row.embedding, dimensions)
    ) {
      throw new Error("The embedding provider returned an invalid vector.");
    }
    vectors[row.index] = row.embedding;
    indices.add(row.index);
  }
  return vectors;
};
export const createHttpEmbeddings = (config: {
  endpoint: string;
  apiKey: string;
  model: string;
  dimensions: number;
}): EmbeddingPort => {
  if (
    !Number.isSafeInteger(config.dimensions) ||
    config.dimensions < 1 ||
    !config.model.trim()
  ) {
    throw new Error("A model and positive embedding dimensions are required.");
  }
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("The embedding endpoint must use HTTP.");
  }
  return {
    dimensions: config.dimensions,
    async embed(texts, options) {
      const check = interrupted(options);
      if (check.status !== "ok") {
        return check;
      }
      if (texts.length === 0) {
        return { status: "ok", value: [] };
      }
      try {
        const response = await fetchWithDeadline(
          endpoint.toString(),
          {
            body: JSON.stringify({
              dimensions: config.dimensions,
              input: texts,
              model: config.model,
            }),
            headers: {
              authorization: `Bearer ${config.apiKey}`,
              "content-type": "application/json",
            },
            method: "POST",
          },
          options
        );
        if (!response.ok) {
          throw new Error("The embedding provider rejected the request.");
        }
        const body: unknown = await response.json();
        const vectors = parseEmbeddings(
          body,
          config.model,
          config.dimensions,
          texts.length
        );
        const finalCheck = interrupted(options);
        if (finalCheck.status !== "ok") {
          return finalCheck;
        }
        return { status: "ok", value: vectors };
      } catch {
        const finalCheck = interrupted(options);
        if (finalCheck.status !== "ok") {
          return finalCheck;
        }
        return {
          code: "provider-unavailable",
          reason: "The embedding provider response is unavailable or invalid.",
          status: "unavailable",
        };
      }
    },
    model: config.model,
  };
};
