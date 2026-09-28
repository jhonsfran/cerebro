import evlog from "evlog/nitro/v3";
import { defineConfig } from "nitro";

export default defineConfig({
  serverDir: "./server",
  experimental: {
    asyncContext: true,
  },
  modules: [
    evlog({
      env: { service: "cerebro-web" },
    }),
  ],
});
