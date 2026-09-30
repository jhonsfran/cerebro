import type { RouterClient } from "@orpc/server";

import { protectedProcedure, publicProcedure } from "../index";
import { identityRouter } from "./identity";
import { createMemoryRouter } from "./memory";
import type { MemoryApiFactory } from "./memory";

export const createAppRouter = (memoryApiFactory?: MemoryApiFactory) => ({
  healthCheck: publicProcedure.handler(() => "OK"),
  identity: identityRouter,
  memory: createMemoryRouter(memoryApiFactory),
  privateData: protectedProcedure.handler(({ context }) => ({
    message: "This is private",
    user: context.session?.user,
  })),
});
export const appRouter = createAppRouter();
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
