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
// base, every project. Two things no Vitest test sees are left out: the
// Playwright journeys (`journeyFiles`), and core's dependency on web, which
// is on web's build alone (`buildOnlyDependencies`).
//
//   GRASP_TEST_BASE=HEAD^1 node scripts/test-plan.ts
//
// Writes `projects` (Vitest's `--project` arguments, empty for all) and
// `shards` (a JSON array of shard numbers, empty for none) to
// $GITHUB_OUTPUT, and why to the step summary.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
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
 * Files outside every package that no Vitest test reads: the Playwright
 * journeys and their configs. No test imports them, and the journeys run
 * in full on every ready pull request (`e2e`), so a change to them alone
 * runs no Vitest project. They were the only files outside a package in
 * 22 of 150 merged pull requests (October 2026), each running every
 * project for it.
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
 * writes the App compiler next to it. Core's tests never load it; they
 * serve a stand-in frontend (apps/core/test/global-setup.ts). The frontend
 * core really serves is tested by `workerd`'s smoke and the journeys,
 * which run on every ready pull request. Without this, a change to web
 * alone ran core's projects, four fifths of the suite's time (October
 * 2026). A package that depends on web for its code belongs elsewhere.
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

const linked = z.record(
  z.string(),
  z.object({ version: z.string(), path: z.string() })
);
const listed = z.array(
  z.object({
    name: z.string(),
    path: z.string(),
    dependencies: linked.optional(),
    devDependencies: linked.optional(),
  })
);

/** `vp pm ls` of the workspace's packages, those `filter` selects. */
const listPackages = (filter?: string): z.infer<typeof listed> => {
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
    { encoding: "utf-8" }
  );
  return listed.parse(JSON.parse(output));
};

/** The workspace packages' directories, of those `filter` selects, by pnpm. */
export const packagesSelected = (filter?: string): string[] =>
  listPackages(filter).map(({ path: dir }) => dir);

/** Every workspace package, with its workspace dependencies, by pnpm. */
const workspacePackages = (): WorkspacePackage[] =>
  listPackages().map((entry) => ({
    name: entry.name,
    dir: entry.path,
    dependsOn: Object.values({
      ...entry.dependencies,
      ...entry.devDependencies,
    })
      .filter(({ version }) => version.startsWith("link:"))
      .map(({ path: dir }) => dir),
  }));

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
    // Changed itself, without what depends on it: the root's own files.
    const changed = packagesSelected(`[${base}]`);
    if (changed.includes(root)) {
      why = `Files outside every workspace package changed since ${base} (config, lockfile, CI or tooling): every project.`;
    } else {
      const packages = workspacePackages();
      const affected = reachedPackages(packages, changed);
      projects = affectedProjects(
        specs.map((spec) => ({
          project: spec.project.name,
          file: spec.moduleId,
        })),
        packages.map(({ dir }) => dir),
        affected
      );
      why = `Changed since ${base}: ${
        changed.map((dir) => path.relative(root, dir)).join(", ") ||
        "no package"
      }. With what depends on them: ${
        [...affected].map((dir) => path.relative(root, dir)).join(", ") ||
        "nothing"
      }.`;
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
