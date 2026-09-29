import { createMiddleware } from "@tanstack/react-start";
import { createAuthClient } from "better-auth/react";

import { ENV } from "../env.public";

const authClient = createAuthClient({
  baseURL: process.env.INTERNAL_API_URL ?? ENV.VITE_SERVER_URL,
});

export const authMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    const session = await authClient.getSession({
      fetchOptions: {
        headers: request.headers,
        throw: true,
      },
    });
    return next({
      context: { session },
    });
  }
);
