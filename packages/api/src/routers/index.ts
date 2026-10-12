import type { RouterClient } from "@orpc/server";

import { identityRouter } from "./identity";
import { createMemoryRouter } from "./memory";
import type { MemoryApiFactory } from "./memory";
import { productRouter } from "./product";

export const createAppRouter = (memoryApiFactory?: MemoryApiFactory) => ({
  identity: identityRouter,
  memory: createMemoryRouter(memoryApiFactory),
  product: productRouter,
});
export const appRouter = createAppRouter();
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
