import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineProject } from "vite-plus";

import { adminDefine } from "./vite.config.ts";

export default defineProject({
  define: adminDefine,
  plugins: [tanstackStart(), react()],
  test: {
    name: "admin-components",
    include: ["src/**/*.test.tsx"],
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
