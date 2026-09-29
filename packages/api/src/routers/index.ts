import type { RouterClient } from "@orpc/server";

import { protectedProcedure, publicProcedure } from "../index";
import { identityRouter } from "./identity";
import { memoryRouter } from "./memory";

export const appRouter = {
  healthCheck: publicProcedure.handler(() => "OK"),
  identity: identityRouter,
  memory: memoryRouter,
  privateData: protectedProcedure.handler(({ context }) => ({
    message: "This is private",
    user: context.session?.user,
  })),
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
