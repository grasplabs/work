import stylex from "@stylexjs/unplugin/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineProject } from "vite-plus";

import { adminDefine, damskoStyles } from "./vite.config.ts";

export default defineProject({
  define: adminDefine,
  plugins: [tanstackStart(), stylex(damskoStyles("serve")), react()],
  test: {
    name: "admin-components",
    include: ["src/**/*.test.tsx"],
    // Every page stands in the frame, whose parts are Damsko's: the first
    // page a file renders compiles Damsko's StyleX in Vite's one transform
    // thread, several seconds on a loaded machine, past Vitest's 5 s
    // default, as vite.test.config.ts allows for its first page. A page
    // that never comes to rest still fails, just later (test/app.tsx).
    testTimeout: 30_000,
    environment: "happy-dom",
    // The document's own scripts (public/theme.js) aren't the app's: not
    // fetched, and not an error.
    environmentOptions: {
      happyDOM: {
        settings: {
          disableJavaScriptFileLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
    server: { deps: { inline: [/@tanstack\/(?:react-)?start/u] } },
  },
});
