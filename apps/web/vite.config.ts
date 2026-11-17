import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import linguiMacro from "@lingui/babel-plugin-lingui-macro";
import { getConfig } from "@lingui/conf";
import { lingui } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import stylex from "@stylexjs/unplugin/vite";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { Features } from "lightningcss";
import { defineConfig } from "vite-plus";

import { localePreload } from "./locale-preload.ts";

// Lingui looks for its config from the working directory, which is the repo
// root when Vite+ runs this build, so both of its plugins get this app's.
const linguiConfigPath = fileURLToPath(
  new URL("lingui.config.ts", import.meta.url)
);
const linguiConfig = getConfig({ configPath: linguiConfigPath });

// Grasp UI's components import UI SDK one entry at a time
// (`@ui-sdk/react/dialog`). Vite finds an entry only when a page first
// imports it, bundles it then and reloads the page, so every component
// added to `src/grasp` cost a reload. All its entries are named up front
// instead, read from the package so the list is never out of date.
const uiSdkPackage: unknown = createRequire(import.meta.url)(
  "@ui-sdk/react/package.json"
);
const uiSdkExports =
  typeof uiSdkPackage === "object" &&
  uiSdkPackage !== null &&
  "exports" in uiSdkPackage &&
  typeof uiSdkPackage.exports === "object" &&
  uiSdkPackage.exports !== null
    ? Object.keys(uiSdkPackage.exports)
    : [];
const uiSdkEntries = uiSdkExports
  .filter((entry) => entry.startsWith("./") && entry !== "./package.json")
  .map((entry) => `@ui-sdk/react/${entry.slice(2)}`);

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      // Only a page itself is a file of its own: its component and its
      // loader together, so what the loader reads with comes with the page,
      // not with the app, in one file. What stands in its place (failed,
      // not found, loading) comes with the app: when a page's file can't be
      // fetched, as after a new release, the error that says so must not
      // need a file of its own too. What a route checks before it loads
      // (`validateSearch`, `beforeLoad`) comes with the app too, so it
      // imports only small modules of plain checks.
      codeSplittingOptions: { defaultBehavior: [["loader", "component"]] },
    }),
    // Grasp UI's styles (src/grasp): StyleX compiles each `stylex.create`
    // to class names before React's own transforms, and adds its CSS to
    // the build's stylesheet. Outside any cascade layer, so it holds over
    // Tailwind's layers (its reset of headings and buttons among them)
    // whichever stylesheet the page loads first, as in development.
    // light-dark() is left as it is, which every browser this app supports
    // reads: rewritten, it would lean on variables that only the build's
    // own stylesheet sets, and fail in development.
    stylex({ lightningcssOptions: { exclude: Features.LightDark } }),
    react(),
    babel({
      // Lingui's macros turn the English in the code into catalog lookups
      // first (Babel runs plugins before presets), so the React Compiler
      // sees the code that runs.
      // The plugin itself, not its name: Babel would look a name up from
      // the working directory, the repo root under `vp test`, where only
      // this app has it installed.
      plugins: [[linguiMacro, { linguiConfig }]],
      // Fail the build on anything the React Compiler can't compile,
      // instead of silently shipping it uncompiled.
      presets: [reactCompilerPreset({ panicThreshold: "all_errors" })],
    }),
    // Compiles a `.po` catalog when the page imports it.
    lingui({ configPath: linguiConfigPath }),
    localePreload(),
    tailwindcss(),
  ],
  define: {
    // The build a page runs, in the error reports it sends: the commit CI
    // built it from, or `local`.
    "import.meta.env.VITE_GRASP_BUILD": JSON.stringify(
      process.env.GITHUB_SHA ?? "local"
    ),
  },
  optimizeDeps: {
    include: ["@ui-sdk/core", ...uiSdkEntries],
  },
  build: {
    // Fonts are always files of their own: Vite would inline the smallest
    // (a few of JetBrains Mono's subsets) as `data:` URLs, which the page's
    // CSP refuses (font-src is default-src, 'self'; core's security-headers.ts).
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
  },
  test: {
    setupFiles: ["./src/test-setup.ts"],
  },
  server: {
    // Core (wrangler dev) serves the API and Cap'n Web.
    proxy: {
      // Live transcription is a WebSocket under /api: without its own rule the
      // upgrade never reaches core in dev (dictation and the interview's live line).
      "/api/transcription": { target: "ws://localhost:8787", ws: true },
      "/api": "http://localhost:8787",
      "/rpc": { target: "ws://localhost:8787", ws: true },
      // The document pages run in, with its own policy, and the modules
      // it runs (core's page-frame.ts).
      "/page-frame": "http://localhost:8787",
      "/page-modules": "http://localhost:8787",
      // The SDK docs, which core's build adds to its static files.
      "/docs": "http://localhost:8787",
    },
  },
});
