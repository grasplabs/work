/**
 * Keeps the default catalog's oxlint and oxfmt on the versions vite-plus
 * pins: the repo lints and formats itself with Vite+'s, and its Ultracite
 * resolves them as its peers. Renovate moves them with vite-plus (the
 * "vite+ toolchain" group, .github/renovate.json5) but to their newest
 * release, not vite-plus's pin; this catches either drifting. App code's
 * own are the `oxc` catalog's (packages/compiler/oxc-wasm/pin.json).
 */
import { readFileSync } from "node:fs";

import { parse } from "yaml";
import { z } from "zod";

const workspace = z
  .object({ catalog: z.record(z.string(), z.string()) })
  .parse(parse(readFileSync("pnpm-workspace.yaml", "utf-8")));
const vitePlus = z
  .object({ dependencies: z.record(z.string(), z.string()) })
  .parse(
    JSON.parse(readFileSync("node_modules/vite-plus/package.json", "utf-8"))
  );

const drifted = ["oxlint", "oxfmt"].filter(
  (tool) => `=${workspace.catalog[tool]}` !== vitePlus.dependencies[tool]
);
if (drifted.length > 0) {
  for (const tool of drifted) {
    console.error(
      `pnpm-workspace.yaml's catalog pins ${tool} ${workspace.catalog[tool]}, but vite-plus pins ${vitePlus.dependencies[tool]}: set the catalog's to vite-plus's.`
    );
  }
  process.exit(1);
}
