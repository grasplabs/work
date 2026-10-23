import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vite-plus";

// The state objects are Durable Objects, so their tests run in workerd,
// through the objects' real boundary.
export default defineProject({
  test: {
    // Fails the suite when it isn't running in workerd.
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
  plugins: [
    cloudflareTest({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-15",
        // As the Workers that run the Chat SDK: its adapters keep each
        // request's context in AsyncLocalStorage.
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          CHAT_STATE: { className: "ChatState", useSQLite: true },
        },
      },
    }),
  ],
});
