/**
 * The Brain's stemmers (packages/brain-next/src/snowball/) are generated
 * output of the Snowball project at the release pinned below: its
 * JavaScript archive's files, byte for byte, with its BSD-3 licence
 * (`COPYING`). They are never edited by hand. Moving to another release
 * changes how words are stemmed, so the Brain's stems must be indexed
 * again after it.
 *
 *   node scripts/brain-snowball.ts           download the pinned release
 *                                            and write its files
 *   node scripts/brain-snowball.ts --check   check the committed files
 *                                            against their pinned hashes
 *                                            (no network; CI runs it as
 *                                            `vp run check:snowball`)
 *
 * The Snowball site publishes no checksums: the archive's SHA-256 was
 * pinned when it was first downloaded, and a download whose archive has
 * another hash is refused. To upgrade, change `release`, `archiveSha256`
 * and each file's hash together.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The Snowball release, and the SHA-256 of its JavaScript archive. */
const release = "3.2.0";
const archiveSha256 =
  "1d3f39267a15d0351312ff4d778de7bb8aae6480a63c4b318eda31032a15e5bd";

/**
 * The files the Brain uses, from the archive's `javascript/` (the
 * stemmers and the base class they extend) and its root (`COPYING`), with
 * the SHA-256 of each.
 */
const files = {
  "base-stemmer.js":
    "ca7982734b537fa7366d70907363f793bee82ed412794c5cd60f0d62b2629ecc",
  "english-stemmer.js":
    "33a4c8574cb52884828ac3dd5155b9104c720342b3e34e507c2f745b8824beef",
  "dutch-stemmer.js":
    "2fa4051e9ce53f8ed54b768a946e885bb514d154a59f80672c7619c6506c88dc",
  "german-stemmer.js":
    "5fc4b96f598e7a152561384bc319acc89a9647d7f88223e5568faaac94bb0e3e",
  "french-stemmer.js":
    "84e6288f672650a25add2c80ac5dd8860a2bacefba9e2171bcc0676263d7da13",
  "spanish-stemmer.js":
    "5666d9027d648f01ea41951205ce864c774a7336f787d9b1df091820a5cf2471",
  COPYING: "880802872ce34f313df826e96131b1b147dcfa09c76fc82129f25503a922a678",
} as const;

const target = path.join(
  import.meta.dirname,
  "../packages/brain-next/src/snowball"
);

const sha256Of = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * What in `dir` is not the release's own: each of `files` that is missing
 * or whose bytes differ from its pinned hash, and anything else the folder
 * holds (lint skips the folder as generated, so a file of our own there
 * would go unchecked). The licence is one of `files`.
 */
export const problemsIn = (dir: string): string[] => [
  ...Object.entries(files)
    .filter(([file, hash]) => {
      const at = path.join(dir, file);
      return !existsSync(at) || sha256Of(readFileSync(at)) !== hash;
    })
    .map(([file]) => `${file} differs from the release`),
  ...readdirSync(dir)
    .filter((name) => !Object.hasOwn(files, name))
    .map((name) => `${name} is not one of the release's files`),
];

/** Checks the committed files; exits 1 naming what differs. */
const check = (): void => {
  const problems = problemsIn(target);
  if (problems.length > 0) {
    process.stderr.write(
      `Snowball ${release}: ${problems.join("; ")}. The folder holds the release's files alone, never edited: restore them with node scripts/brain-snowball.ts and remove anything else.\n`
    );
    process.exit(1);
  }
};

/** Downloads the pinned release and writes its files. */
const download = async (): Promise<void> => {
  const response = await fetch(
    `https://snowballstem.org/dist/jsstemmer-${release}.tar.gz`
  );
  if (!response.ok) {
    throw new Error(`Snowball ${release}: HTTP ${response.status}`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = sha256Of(archive);
  if (digest !== archiveSha256) {
    throw new Error(
      `Snowball ${release}: the archive's SHA-256 is ${digest}, not ${archiveSha256}`
    );
  }
  const work = mkdtempSync(path.join(tmpdir(), "snowball-"));
  try {
    writeFileSync(path.join(work, "jsstemmer.tar.gz"), archive);
    execFileSync("tar", ["-xzf", "jsstemmer.tar.gz"], { cwd: work });
    const unpacked = path.join(work, `jsstemmer-${release}`);
    const staged = path.join(work, "files");
    mkdirSync(staged);
    for (const file of Object.keys(files)) {
      const from =
        file === "COPYING"
          ? path.join(unpacked, file)
          : path.join(unpacked, "javascript", file);
      copyFileSync(from, path.join(staged, file));
    }
    const problems = problemsIn(staged);
    if (problems.length > 0) {
      throw new Error(`Snowball ${release}: ${problems.join("; ")}`);
    }
    mkdirSync(target, { recursive: true });
    for (const file of Object.keys(files)) {
      copyFileSync(path.join(staged, file), path.join(target, file));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  process.stdout.write(`Snowball ${release} stemmers in ${target}\n`);
};

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    check();
  } else {
    await download();
  }
}
