/**
 * The admin as Cloudflare's cf CLI deploys it: built with Vite for a stage
 * (`vp build --mode staging` or `--mode production`, the mode this reads),
 * then deployed with `cf deploy --prebuilt --mode <stage>` (deploy-platform). Its
 * bindings and settings come from wrangler.jsonc, through `cfWorker`
 * (cf-worker.ts), with what the deploy looked up from the environment.
 */
import { readFileSync } from "node:fs";

import { defineConfig } from "cf/config";

import { cfWorker } from "./cf-worker.ts";

export default defineConfig((ctx) => ({
  worker: cfWorker(
    readFileSync(new URL("wrangler.jsonc", import.meta.url), "utf-8"),
    // The names module's stages: staging by its mode, else production.
    ctx.mode === "staging" ? "staging" : "production",
    {
      SECRETS_STORE_ID: process.env.SECRETS_STORE_ID,
      ROUTER_HOSTS_ID: process.env.ROUTER_HOSTS_ID,
      STORED_SECRETS: process.env.STORED_SECRETS,
    }
  ),
}));
