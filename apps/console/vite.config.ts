import { cloudflare } from "@cloudflare/vite-plugin";
import type { PluginConfig } from "@cloudflare/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

/**
 * The console's plugins, its Worker as wrangler.jsonc has it, with `worker`
 * on top: what the browser journeys change (vite.e2e.config.ts).
 */
export const consolePlugins = (worker: PluginConfig = {}) => [
  cloudflare({ viteEnvironment: { name: "ssr" }, ...worker }),
  tanstackStart(),
  react(),
  // Fail the build on anything the React Compiler can't compile, instead
  // of silently shipping it uncompiled.
  babel({ presets: [reactCompilerPreset({ panicThreshold: "all_errors" })] }),
  tailwindcss(),
];

export default defineConfig({ plugins: consolePlugins() });
