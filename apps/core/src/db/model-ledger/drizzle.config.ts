import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/db/model-ledger/schema.ts",
  out: "./src/db/model-ledger/migrations",
});
