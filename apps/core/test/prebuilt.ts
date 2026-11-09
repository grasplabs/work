import { execFileSync } from "node:child_process";
/**
 * What core's global setup builds, kept by a hash of everything it is
 * built from, so a run whose inputs are byte for byte those of an earlier
 * build reuses that build instead of building again: the App compiler,
 * the extractor and connect's bundle took some 30 s of every CI shard's
 * start. CI restores the directory (or a job builds it once and hands it
 * to every shard: test/prebuild.ts); locally the second run reuses the
 * first's.
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
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
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "patches",
  "tsconfig.json",
  "vite.config.ts",
] as const;

const git = (args: readonly string[]): Buffer =>
  execFileSync("git", args, { cwd: repo, maxBuffer: 256 * 1024 * 1024 });

/**
 * The hash of the inputs as they are on disk: the index's hash of each
 * tracked file, and the content of each file changed, added or removed
 * since. Null outside a git checkout, where nothing is reused.
 */
export const prebuiltKey = (): string | null => {
  const hash = createHash("sha256").update(process.version);
  try {
    hash.update(git(["ls-files", "-s", "-z", "--", ...prebuiltInputs]));
    const changed = git([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ...prebuiltInputs,
    ])
      .toString()
      .split("\0")
      .filter((entry) => entry.length > 3)
      .map((entry) => entry.slice(3))
      .toSorted();
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
  rmSync(files.assets, { recursive: true, force: true });
  for (const [what, name] of names) {
    const to = files[what];
    mkdirSync(path.dirname(to), { recursive: true });
    // Copied aside and moved in whole: the version module is shared by
    // the runs in a checkout (compiler-version.ts).
    const aside = `${to}.${process.pid}.tmp`;
    cpSync(path.join(kept, name), aside, { recursive: true });
    renameSync(aside, to);
  }
  return true;
};

/**
 * Keeps the run's build under `key`, in place of any other: written aside
 * and moved in whole, so a run reading the directory never sees half of it.
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
  for (const name of readdirSync(prebuiltRoot)) {
    if (!name.startsWith(".") && name !== key) {
      rmSync(path.join(prebuiltRoot, name), { recursive: true, force: true });
    }
  }
  try {
    renameSync(aside, path.join(prebuiltRoot, key));
  } catch {
    // Another run kept the same build first.
    rmSync(aside, { recursive: true, force: true });
  }
};
