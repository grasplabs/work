import stylex from "@stylexjs/unplugin/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineProject } from "vite-plus";

import { adminDefine, damskoStyles } from "./vite.config.ts";

export default defineProject({
  define: adminDefine,
  plugins: [tanstackStart(), stylex(damskoStyles), react()],
  test: {
    name: "admin-components",
    include: ["src/**/*.test.tsx"],
    // The first page with a Damsko component compiles its StyleX, which
    // took 7 s on a loaded machine (133 ms for a page on the old kit), past
    // Vitest's 5 s default, as vite.test.config.ts allows for its first
    // page. A hang still fails, just later.
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
