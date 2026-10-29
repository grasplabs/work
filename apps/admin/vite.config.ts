import { cloudflare } from "@cloudflare/vite-plugin";
import type { PluginConfig } from "@cloudflare/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

/** What the admin has in discord.js's place. */
const discordGateway = `${import.meta.dirname}/src/admin/discord-gateway.ts`;

/**
 * The admin's plugins, its Worker as wrangler.jsonc has it, with `worker`
 * on top: what the browser journeys change (vite.e2e.config.ts).
 */
export const adminPlugins = (worker: PluginConfig = {}) => [
  // The Discord adapter's Gateway client stays out of the Worker
  // (src/admin/discord-gateway.ts).
  {
    name: "grasp:discord-without-gateway",
    config: () => ({ resolve: { alias: { "discord.js": discordGateway } } }),
  },
  cloudflare({ viteEnvironment: { name: "ssr" }, ...worker }),
  tanstackStart(),
  react(),
  // Fail the build on anything the React Compiler can't compile, instead
  // of silently shipping it uncompiled.
  babel({ presets: [reactCompilerPreset({ panicThreshold: "all_errors" })] }),
  tailwindcss(),
];

/**
 * What a local run of the admin (`vp dev`, and the browser journeys'
 * server) runs its Worker with beyond wrangler.jsonc: workerd implements
 * no Durable Object jurisdictions (src/env.d.ts, src/workflow-runs.ts),
 * as core's and connect's local runs pass too. Never in a build: a
 * deployment keeps its objects in the EU.
 */
export const localVars = { DURABLE_OBJECT_JURISDICTION: "none" } as const;

/** The admin's Worker as `command` runs it: local vars for `serve` alone. */
export const adminWorker = (command: "serve" | "build"): PluginConfig =>
  command === "serve"
    ? { config: (worker) => ({ vars: { ...worker.vars, ...localVars } }) }
    : {};

export default defineConfig(({ command }) => ({
  plugins: adminPlugins(adminWorker(command)),
}));
