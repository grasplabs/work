/**
 * Generates a connector's tools from its vendor's OpenAPI spec (GRA-2319):
 * downloads the spec, keeps it in `folder` as fetched, and writes
 * `tools.gen.ts` beside it with the compiler's generator. The generated
 * file records the spec's URL and hash, and connect's build holds the
 * tools to the spec beside the connector's entry, so a changed spec is a
 * regeneration and a review, never a silent drift. Regeneration replaces
 * the file: the connector's own code lives in its other files.
 *
 *   node scripts/connector-openapi.ts <folder> <spec URL>
 *     [--scheme <the spec's name for the sign-in>] [--reach own|company|others]
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { toolReachSchema } from "@grasp-os/shared/connect";

import { generateConnector } from "../packages/compiler/src/openapi-source.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { scheme: { type: "string" }, reach: { type: "string" } },
});
const [folder, url] = positionals;
if (folder === undefined || url === undefined) {
  throw new Error(
    "Usage: node scripts/connector-openapi.ts <folder> <spec URL> [--scheme <name>] [--reach own|company|others]"
  );
}

const response = await fetch(url, { redirect: "error" });
if (!response.ok) {
  throw new Error(`The spec answered ${response.status}.`);
}
const text = await response.text();
const { source, spec } = await generateConnector(text, url, {
  scheme: values.scheme,
  reach:
    values.reach === undefined
      ? undefined
      : toolReachSchema.parse(values.reach),
});

const extension = new URL(url).pathname.endsWith(".json") ? "json" : "yaml";
writeFileSync(path.join(folder, `openapi.${extension}`), text);
writeFileSync(path.join(folder, "tools.gen.ts"), source);

process.stdout.write(
  `${spec.operations.length} tools from ${url} (sha256 ${spec.sha256}).\n`
);
for (const skipped of spec.skipped) {
  process.stdout.write(`Skipped ${skipped.operation}: ${skipped.reason}\n`);
}
