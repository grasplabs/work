import { cloudflare } from "@cloudflare/vite-plugin";
import type { PluginConfig } from "@cloudflare/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { bindings } from "cf/config";
import { defineConfig } from "vite-plus";

/**
 * The build the admin's pages run, in the errors they report
 * (src/admin/page-errors.ts): the commit CI built it from, or `local`.
 */
export const adminDefine = {
  "import.meta.env.VITE_GRASP_BUILD": JSON.stringify(
    process.env.GITHUB_SHA ?? "local"
  ),
};

/**
 * The admin's plugins, its Worker as cloudflare.config.ts builds it from
 * wrangler.jsonc, with `worker` on top: what the browser journeys change
 * (vite.e2e.config.ts).
 */
export const adminPlugins = (worker: PluginConfig = {}) => [
  cloudflare({ viteEnvironment: { name: "ssr" }, ...worker }),
  tanstackStart(),
  react(),
  // Fail the build on anything the React Compiler can't compile, instead
  // of silently shipping it uncompiled.
  babel({ presets: [reactCompilerPreset({ panicThreshold: "all_errors" })] }),
  tailwindcss(),
  { name: "grasp-admin-build", config: () => ({ define: adminDefine }) },
];

/**
 * What a local run of the admin (`vp dev`, and the browser journeys'
 * server) runs its Worker with beyond wrangler.jsonc: workerd implements
 * no Durable Object jurisdictions (src/env.d.ts, src/workflow-runs.ts),
 * as core's and connect's local runs pass too; a local run answers on
 * localhost, never moving to production's own hostname (src/admin-host.ts).
 * Never in a build: a deployment keeps its objects in the EU.
 */
export const localVars = {
  DURABLE_OBJECT_JURISDICTION: "none",
  ADMIN_HOST: "",
} as const;

/** `localVars` as the Worker's text bindings (cf's config). */
export const localEnv = Object.fromEntries(
  Object.entries(localVars).map(([name, value]) => [name, bindings.text(value)])
);

/** The admin's Worker as `command` runs it: local vars for `serve` alone. */
export const adminWorker = (command: "serve" | "build"): PluginConfig =>
  command === "serve"
    ? { config: (worker) => ({ env: { ...worker.env, ...localEnv } }) }
    : {};

export default defineConfig(({ command }) => ({
  plugins: adminPlugins(adminWorker(command)),
}));
