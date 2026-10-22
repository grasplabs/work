import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/db/vector-catalog/schema.ts",
  out: "./src/db/vector-catalog/migrations",
});
