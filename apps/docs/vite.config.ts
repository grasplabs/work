import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineProject } from "vite-plus";

/** Where the examples test writes each page's App (examples.test.ts). */
export const examplesDir = fileURLToPath(new URL(".examples", import.meta.url));

const generatedPrefix = "@server/_generated/";

// The guides' code, checked as Grasp checks an App's (examples.test.ts),
// in Node: it runs the App's server code to read its manifest, as the
// host's inspection does, with `@server/_generated/*` resolved in the
// App it is imported from.
export default defineProject({
  plugins: [
    {
      name: "app-generated-modules",
      resolveId: (source, importer) => {
        if (!source.startsWith(generatedPrefix) || importer === undefined) {
          return null;
        }
        const [app] = path.relative(examplesDir, importer).split(path.sep);
        return app === undefined
          ? null
          : path.join(
              examplesDir,
              app,
              "server/_generated",
              `${source.slice(generatedPrefix.length)}.ts`
            );
      },
    },
  ],
  test: { name: "docs", environment: "node" },
});
