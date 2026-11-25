import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  frontendDirectives,
  policy,
} from "@grasp-os/shared/content-security-policy";
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
import type { Plugin } from "vite-plus";

import { bootPreload } from "./boot-preload.ts";
import { leanParts } from "./lean-parts.ts";
import { localePreload } from "./locale-preload.ts";

// Lingui looks for its config from the working directory, which is the repo
// root when Vite+ runs this build, so both of its plugins get this app's.
const linguiConfigPath = fileURLToPath(
  new URL("lingui.config.ts", import.meta.url)
);
const linguiConfig = getConfig({ configPath: linguiConfigPath });

// Damsko's tokens give a colour's light and dark values in one
// `light-dark()`, which follows the `color-scheme` of the element that
// uses it. Every browser the app supports reads it; rewritten for older
// ones, it leans on variables only a `color-scheme` rule in the same
// stylesheet sets, and without one each colour is invalid.
const keepLightDark = { exclude: Features.LightDark };

/**
 * Vite's dev server serves the app's code from paths of its own, not the
 * build's `/assets/`: its client (HMR), React Refresh's runtime, the app's
 * source, Damsko's and the kit's source outside this app (`/@fs/`),
 * prebundled packages and virtual modules (StyleX's runtime). Not
 * `/page-modules/`, which core still keeps out.
 */
const devScriptPaths = [
  "/@vite/client",
  "/@react-refresh",
  "/@id/",
  "/@fs/",
  "/src/",
  "/node_modules/",
];

/**
 * Core's policy of the frontend (security-headers.ts), with what the dev
 * server alone needs, so what production refuses is refused here too.
 * Its HMR websocket is to this origin, which `connect-src 'self'`
 * already allows. React Refresh's preamble is an inline script, let
 * through by its hash alone: any other inline script is still refused.
 * StyleX's stylesheet is a virtual module, outside `/assets/` too.
 */
// Worked out once, as the config loads: should plugin-react stop giving
// its preamble, the dev server fails to start rather than on a request.
const preamble = createHash("sha256")
  .update(react.preambleCode.replace("__BASE__", "/"))
  .digest("base64");

const devPolicy = (origin: string): string => {
  const production = frontendDirectives(origin);
  const scripts = devScriptPaths.map((path) => `${origin}${path}`).join(" ");
  return policy({
    ...production,
    "script-src": `${production["script-src"]} ${scripts} 'sha256-${preamble}'`,
    "style-src": `${production["style-src"]} ${origin}/virtual:stylex.css`,
  });
};

/**
 * Sends the policy on everything the dev server answers, as core does in
 * production. What it proxies to core comes with core's own, which
 * replaces it. The origin is the one the browser asked for, as Vite may
 * take another port than 5173.
 */
const devServerPolicy: Plugin = {
  name: "grasp:dev-server-policy",
  apply: "serve",
  configureServer: (server) => {
    server.middlewares.use((request, response, next) => {
      response.setHeader(
        "content-security-policy",
        devPolicy(`http://${request.headers.host ?? "localhost:5173"}`)
      );
      next();
    });
  },
};

export default defineConfig(({ command }) => ({
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
    // Damsko's components (packages/ui) are StyleX: each `stylex.create`
    // is compiled to class names before React's own transforms, in this
    // app's files and the package's alike, and their CSS joins the build's
    // stylesheet. StyleX names a variable by its file's package and path,
    // so both sides of the package boundary agree with no alias here.
    // Outside any cascade layer, where it holds over Tailwind's base
    // layer whichever stylesheet the page loads first: in layers of its
    // own it lost to it whenever its sheet came first, as after an edit
    // in development.
    stylex({
      lightningcssOptions: {
        ...keepLightDark,
        // A cold start in development asks for the CSS before every file
        // is compiled: what can't be read yet is left out, not an error,
        // and the whole CSS follows a moment later. A build reads every
        // file first, so there a CSS error fails it.
        errorRecovery: command === "serve",
        minify: true,
      },
    }),
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
    // The lean pages' own part of the stylesheet and of each catalog.
    leanParts({ linguiConfig }),
    localePreload(),
    bootPreload(),
    tailwindcss(),
    devServerPolicy,
  ],
  css: { lightningcss: keepLightDark },
  define: {
    // The build a page runs, in the error reports it sends: the commit CI
    // built it from, or `local`.
    "import.meta.env.VITE_GRASP_BUILD": JSON.stringify(
      process.env.GITHUB_SHA ?? "local"
    ),
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
}));
