/**
 * Writes a release's limit evidence (evidence-lib.ts) into its directory,
 * at publish, for upload-release.ts to put next to its manifest. Fails,
 * so nothing is published, when the release raises a platform limit over
 * the release before it without evidence for it.
 *
 * Usage: vp run release:evidence --release <dir> --previous <file>
 *        [--evidence <file>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { limitEvidenceFile } from "@grasp-os/shared/release";

import { limitEvidenceFor } from "./evidence-lib.ts";
import { verifyRelease } from "./manifest-lib.ts";

const { values: args } = parseArgs({
  options: {
    release: { type: "string" },
    previous: { type: "string" },
    evidence: { type: "string" },
  },
});
if (args.release === undefined || args.previous === undefined) {
  throw new Error("--release <dir> and --previous <file> are required");
}
const releaseDir = path.resolve(args.release);
const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(path.resolve(file), "utf-8"));

const { manifest } = await verifyRelease(releaseDir);
const file = limitEvidenceFor(
  manifest,
  readJson(args.previous),
  args.evidence === undefined ? [] : readJson(args.evidence)
);
writeFileSync(
  path.join(releaseDir, limitEvidenceFile),
  `${JSON.stringify(file, null, 2)}\n`
);
console.info(
  `Release ${manifest.releaseId}: raised over ${file.previousRelease?.releaseId ?? "nothing"}, ${file.limitEvidence.length} evidence entries`
);
