/**
 * What core's global setup builds, kept by a hash of everything it is
 * built from, so a run whose inputs are byte for byte those of an earlier
 * build reuses that build instead of building again: the App compiler,
 * the extractor and connect's bundle took some 30 s of every CI shard's
 * start. CI restores it by this key (ci.yml), which test/prebuilt-key.ts
 * prints; locally the second run reuses the first's.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const repo = path.join(import.meta.dirname, "../../..");

/** Where the builds are kept, one directory per key. */
export const prebuiltRoot = path.join(
  import.meta.dirname,
  "../dist/test-prebuilt"
);

/**
 * Everything the builds read, relative to the repo: the compiler and the
 * kit it bundles, connect and its connectors (packages/), the extractor,
 * the assets the tests serve, the builds' own code, and the dependencies.
 * Wider than they need, never narrower: a change here only builds again.
 */
export const prebuiltInputs = [
  "packages",
  "apps/connect",
  "apps/core/src/knowledge/extractor",
  "apps/core/build-extractor.ts",
  "apps/core/test/fixtures/assets",
  "apps/core/test/build-connect.ts",
  "apps/core/test/global-setup.ts",
  "apps/core/test/prebuilt.ts",
  "apps/core/test/run-node.ts",
  "apps/core/package.json",
  "apps/core/tsconfig.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "patches",
  "tsconfig.base.json",
  "tsconfig.json",
  "vite.config.ts",
] as const;

const git = (args: readonly string[]): Buffer =>
  execFileSync("git", args, { cwd: repo, maxBuffer: 256 * 1024 * 1024 });

/**
 * The paths `git status --porcelain=v1 -z` names, sorted: each entry is
 * `XY path`, and a rename's or copy's (`R`, `C`) is followed by the path
 * it came from as a field of its own, which is skipped.
 */
const changedFiles = (status: string): string[] => {
  const fields = status.split("\0");
  const files: string[] = [];
  for (let at = 0; at < fields.length; at += 1) {
    const entry = fields[at] ?? "";
    if (entry.length > 3) {
      files.push(entry.slice(3));
      if (entry.startsWith("R") || entry.startsWith("C")) {
        at += 1;
      }
    }
  }
  return files.toSorted();
};

/**
 * The hash of the inputs as they are on disk: the index's hash of each
 * tracked file, and the content of each file changed, added or removed
 * since. Null outside a git checkout, where nothing is reused.
 */
export const prebuiltKey = (): string | null => {
  const hash = createHash("sha256").update(process.version);
  try {
    hash.update(git(["ls-files", "-s", "-z", "--", ...prebuiltInputs]));
    const changed = changedFiles(
      git([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        ...prebuiltInputs,
      ]).toString()
    );
    for (const file of changed) {
      const full = path.join(repo, file);
      hash.update(`\0${file}\0`);
      hash.update(existsSync(full) ? readFileSync(full) : "removed");
    }
  } catch {
    return null;
  }
  return hash.digest("hex").slice(0, 32);
};

/** What is kept: where each lives in a run, and its name in the build. */
export interface PrebuiltFiles {
  assets: string;
  versionModule: string;
  connectBundle: string;
}

const names: readonly (readonly [keyof PrebuiltFiles, string])[] = [
  ["assets", "assets"],
  ["versionModule", "compiler-version.js"],
  ["connectBundle", "connect.js"],
];

const complete = "complete";

/** Copies the build kept under `key` into the run's places: whether there was one. */
export const restorePrebuilt = (key: string, files: PrebuiltFiles): boolean => {
  const kept = path.join(prebuiltRoot, key);
  if (!existsSync(path.join(kept, complete))) {
    return false;
  }
  // Marked as used before it is read, so no other run's pruning takes it
  // away meanwhile (`pruneKept`).
  const now = new Date();
  utimesSync(kept, now, now);
  rmSync(files.assets, { recursive: true, force: true });
  for (const [what, name] of names) {
    const to = files[what];
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(path.join(kept, name), to, { recursive: true });
  }
  return true;
};

/** How many builds are kept, the most recently used first. */
const keptBuilds = 3;

/**
 * How long a build no run used is kept past {@link keptBuilds}: far longer
 * than a run takes to copy one, so a run reading a build never has it
 * removed under it.
 */
const unusedForMs = 60 * 60_000;

/**
 * Removes the builds past the {@link keptBuilds} most recently used, and
 * any half-written one, once no run has used it for {@link unusedForMs}.
 */
const pruneKept = (): void => {
  const entries = readdirSync(prebuiltRoot).map((name) => {
    const full = path.join(prebuiltRoot, name);
    return { name, full, usedAt: statSync(full).mtimeMs };
  });
  const builds = entries
    .filter(({ name }) => !name.startsWith("."))
    .toSorted((a, b) => b.usedAt - a.usedAt);
  const aside = entries.filter(({ name }) => name.startsWith("."));
  const unusedSince = Date.now() - unusedForMs;
  for (const { full, usedAt } of [...builds.slice(keptBuilds), ...aside]) {
    if (usedAt < unusedSince) {
      rmSync(full, { recursive: true, force: true });
    }
  }
};

/**
 * Keeps the run's build under `key`: written aside and moved in whole, so
 * a run reading the directory never sees half of it. Other keys' builds
 * stay for runs that still read them; only long-unused ones go.
 */
export const savePrebuilt = (key: string, files: PrebuiltFiles): void => {
  const aside = path.join(prebuiltRoot, `.${process.pid}`);
  rmSync(aside, { recursive: true, force: true });
  for (const [what, name] of names) {
    cpSync(files[what], path.join(aside, name), {
      recursive: true,
    });
  }
  writeFileSync(path.join(aside, complete), key);
  try {
    renameSync(aside, path.join(prebuiltRoot, key));
  } catch {
    // Another run kept the same build first.
    rmSync(aside, { recursive: true, force: true });
  }
  pruneKept();
};
