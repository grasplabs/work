/**
 * Puts the Snowball project's JavaScript stemmers for the Brain's five
 * languages into packages/brain-next/src/snowball/, as the Snowball
 * release ships them: its own generated output, byte for byte, with its
 * BSD-3 licence. Run it to move to another release (change `release` and
 * `sha256`), then index the Brain's stems again: a stemmer that stems
 * differently no longer matches what the store holds.
 *
 *   node scripts/brain-snowball.ts
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The Snowball release, and the SHA-256 of its JavaScript archive. */
const release = "3.2.0";
const sha256 =
  "1d3f39267a15d0351312ff4d778de7bb8aae6480a63c4b318eda31032a15e5bd";

/** The stemmers the Brain uses, and the base class they extend. */
const files = [
  "base-stemmer.js",
  "english-stemmer.js",
  "dutch-stemmer.js",
  "german-stemmer.js",
  "french-stemmer.js",
  "spanish-stemmer.js",
];

const target = path.join(
  import.meta.dirname,
  "../packages/brain-next/src/snowball"
);

const response = await fetch(
  `https://snowballstem.org/dist/jsstemmer-${release}.tar.gz`
);
if (!response.ok) {
  throw new Error(`Snowball ${release}: HTTP ${response.status}`);
}
const archive = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(archive).digest("hex");
if (digest !== sha256) {
  throw new Error(`Snowball ${release}: SHA-256 ${digest}, not ${sha256}`);
}

const work = mkdtempSync(path.join(tmpdir(), "snowball-"));
try {
  writeFileSync(path.join(work, "jsstemmer.tar.gz"), archive);
  execFileSync("tar", ["-xzf", "jsstemmer.tar.gz"], { cwd: work });
  const unpacked = path.join(work, `jsstemmer-${release}`);
  mkdirSync(target, { recursive: true });
  for (const file of files) {
    copyFileSync(
      path.join(unpacked, "javascript", file),
      path.join(target, file)
    );
  }
  copyFileSync(path.join(unpacked, "COPYING"), path.join(target, "COPYING"));
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.stdout.write(`Snowball ${release} stemmers in ${target}\n`);
