import type { z } from "zod";

import { ENV } from "../../env.public";

let accessGeneration = 0;
export const currentAccessGeneration = (): number => accessGeneration;

const CACHE_PREFIX = "cerebro:product:";
export const apiUrl = (path: string): string =>
  `${ENV.VITE_SERVER_URL.replace(/\/$/u, "")}${path}`;
export class ProductError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProductError";
    this.status = status;
  }
}
export const assertCurrentAccess = (generation: number): void => {
  if (generation !== accessGeneration) {
    throw new ProductError(
      403,
      "Access changed while the request was pending."
    );
  }
};

export const clearProductCache = (): void => {
  accessGeneration += 1;
  for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = sessionStorage.key(index);
    if (key?.startsWith(CACHE_PREFIX)) {
      sessionStorage.removeItem(key);
    }
  }
  window.dispatchEvent(new Event("cerebro:access-cleared"));
};
export const cacheKey = (
  userId: string,
  conversationId: string,
  name: string
): string => `${CACHE_PREFIX}${userId}:${conversationId}:${name}`;
export const request = async <Value>(
  path: string,
  schema: z.ZodType<Value>,
  init?: RequestInit,
  access: "required" | "optional-budget" = "required"
): Promise<Value> => {
  const generation = currentAccessGeneration();
  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const optionalBudgetDenial =
      response.status === 403 &&
      access === "optional-budget" &&
      path === "/api/product/budget";
    if (
      response.status === 401 ||
      (response.status === 403 && !optionalBudgetDenial)
    ) {
      clearProductCache();
    }
    let message = `The request failed (${response.status}).`;
    try {
      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "message" in body &&
        typeof body.message === "string"
      ) {
        ({ message } = body);
      }
    } catch {
      message =
        response.status === 503
          ? "The service is unavailable. Retry the same request."
          : message;
    }
    throw new ProductError(response.status, message);
  }
  const body: unknown = await response.json();
  assertCurrentAccess(generation);
  return schema.parse(body);
};
export const mutate = <Value>(
  path: string,
  body: unknown,
  schema: z.ZodType<Value>,
  method = "POST"
): Promise<Value> =>
  request<Value>(path, schema, { body: JSON.stringify(body), method });
export const productPath = (suffix: string): string => `/api/product/${suffix}`;
export const encoded = encodeURIComponent;
