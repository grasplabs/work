import path from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import type { PluginConfig } from "@cloudflare/vite-plugin";
import babel from "@rolldown/plugin-babel";
import stylex from "@stylexjs/unplugin/vite";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { bindings } from "cf/config";
import { Features } from "lightningcss";
import { defineConfig } from "vite-plus";

import { serverOnlyCheck } from "./server-only-check.ts";

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
 * Damsko's tokens give a colour's light and dark values in one
 * `light-dark()`, which every browser staff use reads: kept as written by
 * both of the CSS passes, StyleX's and Vite's, as in apps/web.
 */
const keepLightDark = { exclude: Features.LightDark };

/**
 * Damsko's components (packages/ui) are StyleX, compiled to class names
 * before React's own transforms (the plugin runs first, whatever its place
 * in a list), their CSS joined to the browser's stylesheet outside any
 * cascade layer, as in apps/web, whose config says why. Its plugin, typed
 * as `any`, is called where each config lists its plugins: here, in
 * vite.e2e.config.ts and vite.components.config.ts.
 */
export const damskoStyles = {
  lightningcssOptions: { ...keepLightDark, errorRecovery: true, minify: true },
};

/**
 * The admin's plugins, its Worker as cloudflare.config.ts builds it from
 * wrangler.jsonc, with `worker` on top: what the browser journeys change
 * (vite.e2e.config.ts).
 */
export const adminPlugins = (worker: PluginConfig = {}) => [
  cloudflare({ viteEnvironment: { name: "ssr" }, ...worker }),
  // The browser's build fails on anything of the Worker's that would reach
  // it: a module marked server-only (`import
  // "@tanstack/react-start/server-only"`) whose code survives into it, its
  // bindings, its database, and test helpers. A server function's own body
  // is the server's alone, and never counts. Every module the browser
  // doesn't load must be marked (server-only-check.ts).
  tanstackStart({
    importProtection: {
      behavior: "error",
      client: {
        specifiers: ["cloudflare:workers", "drizzle-orm", /^drizzle-orm\//u],
        // Start's own default (`*.server.*`) as well, which a list of
        // files would otherwise replace; and the tests' helpers, never the
        // app's.
        files: ["**/*.server.*", "**/src/db/**", "test/**"],
      },
    },
  }),
  react(),
  // Fail the build on anything the React Compiler can't compile, instead
  // of silently shipping it uncompiled.
  babel({ presets: [reactCompilerPreset({ panicThreshold: "all_errors" })] }),
  tailwindcss(),
  {
    name: "grasp-admin-build",
    config: () => ({
      define: adminDefine,
      css: { lightningcss: keepLightDark },
    }),
  },
  serverOnlyCheck(path.join(import.meta.dirname, "src")),
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
  plugins: [stylex(damskoStyles), ...adminPlugins(adminWorker(command))],
}));
