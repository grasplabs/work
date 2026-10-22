import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/db/vector-shard/schema.ts",
  out: "./src/db/vector-shard/migrations",
});
