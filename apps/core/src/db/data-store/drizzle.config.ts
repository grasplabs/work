import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/db/data-store/schema.ts",
  out: "./src/db/data-store/migrations",
});
