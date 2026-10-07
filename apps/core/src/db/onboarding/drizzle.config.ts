import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/db/onboarding/schema.ts",
  out: "./src/db/onboarding/migrations",
});
