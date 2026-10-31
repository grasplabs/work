// Plans CI's test shards for a run (.github/workflows/ci.yml, the `plan`
// job): which Vitest projects the run's changes can affect, and how many
// shards those projects' files take (scripts/test-shards.ts).
//
// A pull request runs only the projects with a test file in a workspace
// package it changed, or in one that depends on such a package, directly
// or not: pnpm's own dependency graph (`--filter "...[<base>]"`) says
// which, from every package.json in the workspace. A change outside every
// package (the root's config, the lockfile, CI, the repo's tooling) can
// reach any test, so it runs them all, as the merge queue always does: no
// base, every project. Two exceptions: a change to the Playwright journeys
// runs only the projects whose tests import it (`journeyFiles`), and
// core's dependency on web, which is on web's build alone, isn't followed
// (`buildOnlyDependencies`).
//
//   GRASP_TEST_BASE=HEAD^1 node scripts/test-plan.ts
//
// Writes `projects` (Vitest's `--project` arguments, empty for all) and
// `shards` (a JSON array of shard numbers, empty for none) to
// $GITHUB_OUTPUT, and why to the step summary.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

import { createVitest } from "vite-plus/test/node";
import { z } from "zod";

import { shardFileOf } from "./test-sequencer.ts";
import { byKey, shardCountFor } from "./test-shards.ts";

/** A test file: its project's name and its absolute path. */
export interface PlannedFile {
  readonly project: string;
  readonly file: string;
}

/** The workspace package a path is in: the deepest one whose directory holds it. */
export const packageOf = (
  file: string,
  packages: readonly string[]
): string | undefined =>
  packages
    .filter((dir) => file === dir || file.startsWith(`${dir}${path.sep}`))
    .toSorted((a, b) => b.length - a.length)[0];

/**
 * The projects to run: those with a file in an `affected` package, in a
 * stable order. `affected` is every package a change reaches, by pnpm's
 * graph; a project whose files are all elsewhere can't see the change.
 */
export const affectedProjects = (
  files: readonly PlannedFile[],
  packages: readonly string[],
  affected: ReadonlySet<string>
): string[] => {
  const projects = new Set<string>();
  for (const { project, file } of files) {
    const own = packageOf(file, packages);
    if (own !== undefined && affected.has(own)) {
      projects.add(project);
    }
  }
  return [...projects].toSorted(byKey);
};

/**
 * Files outside every package that don't reach every test: the Playwright
 * journeys and their configs. They aren't config every test runs under
 * (unlike the root's vite.config.ts or the lockfile), so a change to them
 * runs only the projects with a test that imports one, directly or not,
 * by TypeScript's module resolution (`projectsImporting`). For a journey
 * (e2e/*.e2e.ts) that is none, and the journeys run in full on every ready
 * pull request (`e2e`); for playwright.config.ts it is the scripts
 * project, whose e2e-parts.test.ts imports it through e2e-parts.ts. They
 * were the only files outside a package in 22 of 150 merged pull requests
 * (October 2026), each running every project for it.
 */
export const journeyFiles = [
  "e2e/**",
  "playwright.config.ts",
  "playwright.admin.config.ts",
] as const;

/**
 * Dependencies in pnpm's graph that no test of the dependent sees, by
 * package name: the dependent needs only the dependency's build. Core
 * depends on web for the frontend it serves (apps/core/wrangler.jsonc's
 * assets), and so that `vp run -r build` builds web first: core's build
 * writes the App compiler next to it. Core's tests never load it: no core
 * file imports web, and the tests serve a stand-in frontend
 * (apps/core/test/global-setup.ts writes it, and core's vite.config.ts
 * points the pool's assets at it instead of wrangler.jsonc's). The
 * frontend core really serves is tested by `workerd`'s smoke and the
 * journeys, which run on every ready pull request. Without this, a change
 * to web alone ran core's projects, four fifths of the suite's time
 * (October 2026). A package that depends on web for its code belongs
 * elsewhere.
 */
export const buildOnlyDependencies: ReadonlyMap<string, readonly string[]> =
  new Map([["@grasp-os/core", ["@grasp-os/web"]]]);

/** A workspace package: its name, directory and workspace dependencies. */
export interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  /** The directories of the workspace packages it depends on. */
  readonly dependsOn: readonly string[];
}

/**
 * The packages a change to `changed` (directories) reaches: those, and
 * every package that depends on one of them, directly or not, by any
 * dependency but a build-only one.
 */
export const reachedPackages = (
  packages: readonly WorkspacePackage[],
  changed: Iterable<string>,
  buildOnly: ReadonlyMap<string, readonly string[]> = buildOnlyDependencies
): Set<string> => {
  const nameOf = new Map(packages.map(({ dir, name }) => [dir, name]));
  const reached = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const { dir, name, dependsOn } of packages) {
      const skipped = buildOnly.get(name) ?? [];
      const reaches = dependsOn.some(
        (dependency) =>
          reached.has(dependency) &&
          !skipped.includes(nameOf.get(dependency) ?? "")
      );
      if (!reached.has(dir) && reaches) {
        reached.add(dir);
        grew = true;
      }
    }
  }
  return reached;
};

const listed = z.array(z.object({ name: z.string(), path: z.string() }));

/** `vp pm ls` of the packages `filter` selects in the workspace at `cwd`. */
const listPackages = (
  filter: string | undefined,
  cwd: string
): z.infer<typeof listed> => {
  const output = execFileSync(
    "vp",
    [
      "pm",
      "ls",
      "--recursive",
      "--depth=0",
      "--json",
      ...(filter === undefined ? [] : [`--filter=${filter}`]),
      // pnpm's own flag, which vp passes on after `--`: a change to a
      // journey file alone selects no package by it.
      "--",
      ...journeyFiles.map(
        (pattern) => `--changed-files-ignore-pattern=${pattern}`
      ),
    ],
    { cwd, encoding: "utf-8" }
  );
  return listed.parse(JSON.parse(output));
};

/**
 * The workspace packages' directories, of those `filter` selects, by pnpm,
 * in the workspace at `cwd`.
 */
export const packagesSelected = (
  filter?: string,
  cwd: string = process.cwd()
): string[] => listPackages(filter, cwd).map(({ path: dir }) => dir);

const manifest = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

/**
 * Every workspace package in the workspace at `cwd`, by pnpm, with the
 * workspace packages its package.json depends on, as pnpm's
 * `...[<base>]` follows them, installed or not.
 */
const workspacePackages = (cwd: string): WorkspacePackage[] => {
  const all = listPackages(undefined, cwd);
  const dirOf = new Map(all.map(({ name, path: dir }) => [name, dir]));
  return all.map(({ name, path: dir }) => {
    const { dependencies, devDependencies } = manifest.parse(
      JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8"))
    );
    return {
      name,
      dir,
      dependsOn: Object.keys({ ...dependencies, ...devDependencies })
        .map((dependency) => dirOf.get(dependency))
        .filter((found) => found !== undefined),
    };
  });
};

/** What a change since a base reaches, by pnpm's graph. */
export type Reach =
  /** Files outside every package changed: any test may see them. */
  | { readonly all: true; readonly changed: readonly string[] }
  | {
      readonly all: false;
      /** The packages whose own files changed. */
      readonly changed: readonly string[];
      /** Those and every package that depends on one, directly or not. */
      readonly affected: ReadonlySet<string>;
      /**
       * The changed files outside every package that match `journeyFiles`
       * (absolute paths): they run the projects whose tests import them.
       */
      readonly journeys: readonly string[];
    };

/** The files changed since `base` in the repository at `root`, absolute. */
const filesChangedSince = (base: string, root: string): string[] =>
  execFileSync("git", ["diff", "--name-only", base], {
    cwd: root,
    encoding: "utf-8",
  })
    .split("\n")
    .filter((file) => file !== "")
    .map((file) => path.join(root, file));

/** A line of `tsc --explainFiles` that says which file imports the one above. */
const importedVia = /^\s+Imported via .+ from file '(?<importer>[^']+)'/u;

/**
 * Each file's importers, by TypeScript's own module resolution: `tsc
 * --explainFiles` of every tsconfig.json in the repository at `root`
 * (tsconfig paths, package exports and imports, as type-checking resolves
 * them). Also every file some program holds, so a test no program holds is
 * known as one whose imports are unknown. Vitest's `--related` walk follows
 * each project's Vite environment, and core's Workers pool isn't one it
 * can transform (its .sql imports, the compiler's `#kit`).
 */
const importGraph = (
  root: string
): { importers: Map<string, Set<string>>; files: Set<string> } => {
  const tsconfigs = execFileSync(
    "git",
    ["ls-files", "tsconfig.json", "**/tsconfig.json"],
    { cwd: root, encoding: "utf-8" }
  )
    .split("\n")
    .filter((file) => file !== "");
  const importers = new Map<string, Set<string>>();
  const files = new Set<string>();
  for (const tsconfig of tsconfigs) {
    // Its files whatever the exit: a config with no inputs (TS18003)
    // lists none, and a test no program lists counts as reaching all.
    const { stdout: output } = spawnSync(
      "vp",
      ["exec", "tsc", "-p", tsconfig, "--explainFiles", "--listFilesOnly"],
      { cwd: root, encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 }
    );
    let current: string | undefined;
    for (const line of output.split("\n")) {
      if (line !== "" && !line.startsWith(" ")) {
        current = path.resolve(root, line);
        files.add(current);
        continue;
      }
      const importer = importedVia.exec(line)?.groups?.importer;
      if (current !== undefined && importer !== undefined) {
        const known = importers.get(current) ?? new Set<string>();
        known.add(path.resolve(root, importer));
        importers.set(current, known);
      }
    }
  }
  return { importers, files };
};

/**
 * The projects with a test file (`files` of the plan) that imports one of
 * `changed` (absolute), directly or not, in the repository at `root`, by
 * TypeScript's resolution (`importGraph`). A test file no tsconfig holds
 * counts as importing them: a change is only left out where every test is
 * known not to reach it.
 */
export const projectsImporting = (
  changed: readonly string[],
  tests: readonly PlannedFile[],
  root: string
): string[] => {
  if (changed.length === 0) {
    return [];
  }
  const { importers, files } = importGraph(root);
  const reached = new Set(changed);
  const queue = [...changed];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const importer of importers.get(file) ?? []) {
      if (!reached.has(importer) && !importer.includes("/node_modules/")) {
        reached.add(importer);
        queue.push(importer);
      }
    }
  }
  const projects = new Set<string>();
  for (const { project, file } of tests) {
    if (reached.has(file) || !files.has(file)) {
      projects.add(project);
    }
  }
  return [...projects].toSorted(byKey);
};

/**
 * The packages that changed since `base` (a commit) in the workspace at
 * `root`, and what they reach. A change to the root's own files (config,
 * the lockfile, CI, tooling) reaches everything, but for `journeyFiles`,
 * which are returned apart, for the tests that import them. What depends
 * on a package only for its build (`buildOnly`) isn't reached through it.
 */
export const reachSince = (
  base: string,
  root: string,
  buildOnly: ReadonlyMap<string, readonly string[]> = buildOnlyDependencies
): Reach => {
  // Changed itself, without what depends on it: the root's own files.
  const changed = packagesSelected(`[${base}]`, root);
  if (changed.includes(root)) {
    return { all: true, changed };
  }
  const packages = workspacePackages(root);
  const packageDirs = packages
    .map(({ dir }) => dir)
    .filter((dir) => dir !== root);
  const journeys = filesChangedSince(base, root).filter(
    (file) =>
      packageOf(file, packageDirs) === undefined &&
      journeyFiles.some((pattern) =>
        path.matchesGlob(path.relative(root, file), pattern)
      )
  );
  return {
    all: false,
    changed,
    affected: reachedPackages(packages, changed, buildOnly),
    journeys,
  };
};

const writeOutput = (name: string, value: string): void => {
  const file = process.env.GITHUB_OUTPUT;
  if (file !== undefined && file !== "") {
    appendFileSync(file, `${name}=${value}\n`);
  }
};

const summarize = (lines: readonly string[]): void => {
  console.log(lines.join("\n"));
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file !== undefined && file !== "") {
    appendFileSync(file, `${lines.join("\n")}\n`);
  }
};

const plan = async (base: string | undefined): Promise<void> => {
  const root = process.cwd();
  const vitest = await createVitest("test", { watch: false });
  const specs = await vitest.globTestSpecifications();
  await vitest.close();

  let projects: string[] | undefined;
  let why: string;
  if (base === undefined) {
    why =
      "No base to compare with (the merge queue, or a run by hand): every project.";
  } else {
    const reach = reachSince(base, root);
    if (reach.all) {
      why = `Files outside every workspace package changed since ${base} (config, lockfile, CI or tooling): every project.`;
    } else {
      const { changed, affected, journeys } = reach;
      const packages = packagesSelected(undefined, root);
      const tests = specs.map((spec) => ({
        project: spec.project.name,
        file: spec.moduleId,
      }));
      const importing = projectsImporting(journeys, tests, root);
      projects = [
        ...new Set([
          ...affectedProjects(tests, packages, affected),
          ...importing,
        ]),
      ].toSorted(byKey);
      why = `Changed since ${base}: ${
        changed.map((dir) => path.relative(root, dir)).join(", ") ||
        "no package"
      }. With what depends on them: ${
        [...affected].map((dir) => path.relative(root, dir)).join(", ") ||
        "nothing"
      }.${
        journeys.length === 0
          ? ""
          : ` Journey files: ${journeys
              .map((file) => path.relative(root, file))
              .join(", ")}, imported by tests of ${
              importing.join(", ") || "no project"
            }.`
      }`;
    }
  }

  const selected = new Set(projects);
  const files = specs
    .filter((spec) => projects === undefined || selected.has(spec.project.name))
    .map(shardFileOf);
  const count = shardCountFor(files);
  const shards = Array.from({ length: count }, (_, index) => index + 1);

  writeOutput(
    "projects",
    (projects ?? []).map((project) => `--project=${project}`).join(" ")
  );
  writeOutput("shards", JSON.stringify(shards));
  summarize([
    "### Test plan",
    "",
    why,
    "",
    projects === undefined
      ? `Every project: ${files.length} files in ${count} shards.`
      : `${projects.length} projects (${projects.join(", ") || "none"}): ${files.length} files in ${count} shards.`,
  ]);
};

if (import.meta.main) {
  const base = process.env.GRASP_TEST_BASE;
  await plan(base === undefined || base === "" ? undefined : base);
}
