import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineProject } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

// The kit's component tests (test/*.browser.test.tsx) in a real Chromium,
// Chromium's headless shell as the journeys use: what is accessible needs
// real rendering, focus, layout and the theme's styles. Every component's
// demo and every example, once each, apart from the stack the journeys
// start: they read nothing from core. Core's Content Security Policy over
// the kit's pages is held on the stack (e2e/catalog.e2e.ts).
export default defineProject({
  plugins: [
    react(),
    // The components compiled as the frontend compiles them, failing on
    // anything the React Compiler can't compile (apps/web/vite.config.ts).
    babel({ presets: [reactCompilerPreset({ panicThreshold: "all_errors" })] }),
    tailwindcss(),
  ],
  test: {
    name: "@grasp-os/ui:browser",
    root: import.meta.dirname,
    include: ["test/**/*.browser.test.tsx"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      // The width a phone and a desktop see, each test sets its own.
      viewport: { width: 1280, height: 800 },
    },
  },
});
