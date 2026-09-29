import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  out: "./src/migrations",
  schema: [
    "./src/schema/auth.ts",
    "./src/schema/core.ts",
    "./src/schema/identity.ts",
    "./src/schema/memory.ts",
    "./src/schema/connectors.ts",
    "./src/schema/usage.ts",
  ],
});
