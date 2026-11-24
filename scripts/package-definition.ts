/**
 * Packages a definition package, as core's `apps.definition` exports it,
 * into a standalone project to build outside Grasp
 * (package-definition-lib.ts).
 *
 * Usage: vp run package:definition --package <file.json> --out <dir>
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { packageProject } from "./package-definition-lib.ts";

const ROOT = path.join(import.meta.dirname, "..");

const { values: args } = parseArgs({
  options: {
    package: { type: "string" },
    out: { type: "string" },
  },
});
if (args.package === undefined || args.out === undefined) {
  throw new Error("--package <file.json> and --out <dir> are required");
}

const written = await packageProject({
  definition: JSON.parse(readFileSync(path.resolve(args.package), "utf-8")),
  out: path.resolve(args.out),
  repo: ROOT,
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf-8",
  }).trim(),
});
process.stdout.write(
  `Wrote ${written.length} files to ${path.resolve(args.out)}.\n`
);
