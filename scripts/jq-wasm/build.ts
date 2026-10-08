/**
 * Builds packages/workflow-expressions/src/jq.wasm, the jq that evaluates
 * workflow expressions, from the jq-wasm package: checks the package's
 * bytes against their pinned hash, meters them (./meter.ts) and checks the
 * result against its pinned hash too. Deterministic: the same input always
 * gives the same bytes.
 *
 *   node scripts/jq-wasm/build.ts           writes src/jq.wasm
 *   node scripts/jq-wasm/build.ts --check   fails unless it is up to date
 *
 * After changing the meter or the package version, run it with --print to
 * see the new hash, then pin it in src/provenance.ts.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { jqProvenance } from "../../packages/workflow-expressions/src/provenance.ts";
import { meter } from "./meter.ts";

const packageDir = fileURLToPath(
  new URL("../../packages/workflow-expressions/", import.meta.url)
);
export const outputPath = `${packageDir}src/jq.wasm`;

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The metered jq, built from the installed jq-wasm package. */
export const buildJqWasm = (): Uint8Array => {
  const require = createRequire(`${packageDir}package.json`);
  const upstream = readFileSync(require.resolve("jq-wasm/jq.wasm"));
  const upstreamHash = sha256(upstream);
  if (upstreamHash !== jqProvenance.upstreamSha256) {
    throw new Error(
      `jq-wasm's jq.wasm has SHA-256 ${upstreamHash}, not the pinned ${jqProvenance.upstreamSha256}`
    );
  }
  return meter(upstream, {
    fuelExport: jqProvenance.fuelExport,
    maxMemoryBytes: jqProvenance.maxMemoryBytes,
  });
};

const main = (): void => {
  const { values } = parseArgs({
    options: { check: { type: "boolean" }, print: { type: "boolean" } },
  });
  const built = buildJqWasm();
  const hash = sha256(built);
  if (values.print === true) {
    console.log(hash);
    return;
  }
  if (hash !== jqProvenance.sha256) {
    throw new Error(
      `The metered jq.wasm has SHA-256 ${hash}, not the pinned ${jqProvenance.sha256}`
    );
  }
  if (values.check === true) {
    if (sha256(readFileSync(outputPath)) !== hash) {
      throw new Error(
        `${outputPath} is out of date: run node scripts/jq-wasm/build.ts`
      );
    }
    return;
  }
  writeFileSync(outputPath, built);
};

if (process.argv[1] === import.meta.filename) {
  main();
}
