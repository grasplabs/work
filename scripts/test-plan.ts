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
// Writes `projects` (Vitest's `--project` arguments, empty for all),
// `shards` (a JSON array of shard numbers, empty for none) and, for each
// journey suite, `e2e` and `admin-e2e` (whether its stack changed: true or
// false) to $GITHUB_OUTPUT, and why to the step summary.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { parseSync } from "vite-plus";
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
 * by their parsed and resolved imports (`filesImporting`). For a journey
 * (e2e/*.e2e.ts) that is none, and a change to one runs the journeys
 * (`journeysReached`); for playwright.config.ts it is the scripts
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
 * journeys, which run whenever web changes (`journeysReached`). Without
 * this, a change to web alone ran core's projects, four fifths of the
 * suite's time (October 2026). A package that depends on web for its code
 * belongs elsewhere.
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
      /**
       * Those and every file that imports one, directly or not
       * (`filesImporting`): a test among them runs.
       */
      readonly importers: ReadonlySet<string>;
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

/** The source files that can import others, by extension. */
const sourceFile = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

/**
 * What a relative specifier in `importer` resolves to, as TypeScript and
 * Node resolve one: the path itself, a `.js`-style extension written for
 * its TypeScript source, an added extension, or a folder's index. A
 * `changed` path counts as there even when the change deleted it, so an
 * import of a deleted file still reaches it.
 */
const resolveRelative = (
  importer: string,
  specifier: string,
  changed: ReadonlySet<string>
): string | undefined => {
  // Without a query (`?raw`), which names how, not what.
  const [file = specifier] = specifier.split("?");
  const base = path.resolve(path.dirname(importer), file);
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/u, "");
  const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs"];
  return [
    base,
    ...extensions.map((extension) => `${stem}${extension}`),
    ...extensions.map((extension) => path.join(base, `index${extension}`)),
  ].find(
    (candidate) =>
      changed.has(candidate) ||
      (existsSync(candidate) && statSync(candidate).isFile())
  );
};

/**
 * The files `file` imports by a relative specifier, statically,
 * dynamically or by re-export, parsed by oxc (Vite+'s `parseSync`), or
 * `undefined` when that can't be known: it doesn't parse, or imports by an
 * expression. `changed` paths resolve whether or not they're still there.
 */
const relativeImportsOf = (
  file: string,
  source: string,
  changed: ReadonlySet<string>
): Set<string> | undefined => {
  const { errors, module } = parseSync(file, source);
  if (errors.length > 0) {
    return undefined;
  }
  const specifiers = [
    ...module.staticImports.map(({ moduleRequest }) => moduleRequest.value),
    ...module.staticExports.flatMap(({ entries }) =>
      entries.flatMap(({ moduleRequest }) =>
        moduleRequest === null ? [] : [moduleRequest.value]
      )
    ),
  ];
  for (const { moduleRequest } of module.dynamicImports) {
    const literal = /^(?<quote>["'`])(?<value>[^"'`$]*)\k<quote>$/u.exec(
      source.slice(moduleRequest.start, moduleRequest.end)
    )?.groups?.value;
    if (literal === undefined) {
      return undefined;
    }
    specifiers.push(literal);
  }
  return new Set(
    specifiers
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => resolveRelative(file, specifier, changed))
      .filter((resolved) => resolved !== undefined)
  );
};

/**
 * The files of the repository at `root` that import one of `changed`
 * (absolute), directly or not, and those: each file's own imports, parsed
 * and resolved, walked back from `changed`. A file outside every package
 * has no package name, and every alias here (tsconfig paths, core's
 * `#blueprints` and `#version`) points inside its own package, so only a
 * relative specifier reaches one. Past a file in a package, its package's
 * dependents are reached by pnpm's graph (`reachSince`). A file whose
 * imports can't be known (it doesn't parse, or imports by an expression)
 * that names a file of the walk counts as importing it. Only files that
 * name one are parsed, so the walk reads every source file once and
 * parses few.
 */
export const filesImporting = (
  changed: readonly string[],
  root: string
): Set<string> => {
  const reached = new Set(changed);
  if (changed.length === 0) {
    return reached;
  }
  // Deleted ones included: what still imports a deleted file breaks.
  const changedPaths = new Set(changed);
  const sources = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf-8" }
  )
    .split("\n")
    .filter((file) => sourceFile.test(file))
    .map((file) => path.join(root, file))
    .filter((file) => existsSync(file))
    .map((file) => ({ file, source: readFileSync(file, "utf-8") }));
  const imports = new Map<string, Set<string> | undefined>();
  const queue = [...changed];
  for (let target = queue.pop(); target !== undefined; target = queue.pop()) {
    // A specifier names the file or, for an index, its folder.
    const name = path.basename(target).replace(/\.[^.]+$/u, "");
    const named = name === "index" ? path.basename(path.dirname(target)) : name;
    for (const { file, source } of sources) {
      if (reached.has(file) || !source.includes(named)) {
        continue;
      }
      if (!imports.has(file)) {
        imports.set(file, relativeImportsOf(file, source, changedPaths));
      }
      const resolved = imports.get(file);
      if (resolved === undefined || resolved.has(target)) {
        reached.add(file);
        queue.push(file);
      }
    }
  }
  return reached;
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
  const importers = filesImporting(journeys, root);
  // A package with a file that imports a journey file reaches what
  // depends on it, as a change to it would.
  const holding = [...importers]
    .map((file) => packageOf(file, packageDirs))
    .filter((dir) => dir !== undefined);
  return {
    all: false,
    changed,
    affected: reachedPackages(packages, [...changed, ...holding], buildOnly),
    journeys,
    importers,
  };
};

/**
 * The packages each journey suite's stack runs, by package name: e2e's,
 * core's dev server (playwright.config.ts), which builds web and bundles
 * connect beside it, and admin-e2e's, the admin on the fake Cloudflare API
 * (playwright.admin.config.ts). Every package they depend on runs with
 * them, by pnpm's graph.
 */
export const journeyStacks = {
  e2e: ["@grasp-os/core", "@grasp-os/web", "@grasp-os/connect"],
  "admin-e2e": ["@grasp-os/admin"],
} as const;

export type JourneySuite = keyof typeof journeyStacks;

/**
 * Which journey suites a pull request's changes reach. A suite runs when a
 * changed file sits in a package its stack runs or depends on, directly or
 * not, by every dependency (web's build included, which core serves). Two
 * kinds of change never reach a stack: a Vitest test file (`testFiles`),
 * which no build bundles, and a file in a package no stack depends on (the
 * admin's, for e2e; the router's, for both). A changed file outside every
 * package (a journey, its config, the repo's tooling) runs both. In 150
 * merged pull requests, 33 changed nothing either e2e stack runs, mostly
 * the admin or tests alone, each running every journey for it (October
 * 2026). The merge queue and the nightly run always run both.
 */
export const journeysReached = ({
  changedFiles,
  testFiles,
  packages,
  root,
}: {
  /** Every file changed since the base, absolute. */
  readonly changedFiles: readonly string[];
  /** Every Vitest test file, absolute. */
  readonly testFiles: ReadonlySet<string>;
  readonly packages: readonly WorkspacePackage[];
  readonly root: string;
}): Record<JourneySuite, boolean> => {
  const dirs = packages.map(({ dir }) => dir).filter((dir) => dir !== root);
  const owners = changedFiles
    .filter((file) => !testFiles.has(file))
    .map((file) => packageOf(file, dirs));
  if (owners.includes(undefined)) {
    return { e2e: true, "admin-e2e": true };
  }
  const reached = reachedPackages(
    packages,
    owners.filter((dir) => dir !== undefined),
    new Map()
  );
  const dirOf = new Map(packages.map(({ name, dir }) => [name, dir]));
  const runs = (suite: JourneySuite): boolean =>
    journeyStacks[suite].some((name) => reached.has(dirOf.get(name) ?? ""));
  return { e2e: runs("e2e"), "admin-e2e": runs("admin-e2e") };
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
  let journeys: Record<JourneySuite, boolean> = {
    e2e: true,
    "admin-e2e": true,
  };
  if (base === undefined) {
    why =
      "No base to compare with (the merge queue, or a run by hand): every project.";
  } else {
    const reach = reachSince(base, root);
    if (reach.all) {
      why = `Files outside every workspace package changed since ${base} (config, lockfile, CI or tooling): every project.`;
    } else {
      const { changed, affected, journeys: journeyChanges, importers } = reach;
      const packages = packagesSelected(undefined, root);
      const tests = specs.map((spec) => ({
        project: spec.project.name,
        file: spec.moduleId,
      }));
      const importing = [
        ...new Set(
          tests
            .filter(({ file }) => importers.has(file))
            .map(({ project }) => project)
        ),
      ].toSorted(byKey);
      projects = [
        ...new Set([
          ...affectedProjects(tests, packages, affected),
          ...importing,
        ]),
      ].toSorted(byKey);
      journeys = journeysReached({
        changedFiles: filesChangedSince(base, root),
        testFiles: new Set(tests.map(({ file }) => file)),
        packages: workspacePackages(root),
        root,
      });
      why = `Changed since ${base}: ${
        changed.map((dir) => path.relative(root, dir)).join(", ") ||
        "no package"
      }. With what depends on them: ${
        [...affected].map((dir) => path.relative(root, dir)).join(", ") ||
        "nothing"
      }.${
        journeyChanges.length === 0
          ? ""
          : ` Journey files: ${journeyChanges
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
  writeOutput("e2e", String(journeys.e2e));
  writeOutput("admin-e2e", String(journeys["admin-e2e"]));
  summarize([
    "### Test plan",
    "",
    why,
    "",
    projects === undefined
      ? `Every project: ${files.length} files in ${count} shards.`
      : `${projects.length} projects (${projects.join(", ") || "none"}): ${files.length} files in ${count} shards.`,
    "",
    `Journeys: e2e ${journeys.e2e ? "runs" : "skipped, its stack unchanged"}; admin-e2e ${journeys["admin-e2e"] ? "runs" : "skipped, its stack unchanged"}.`,
  ]);
};

if (import.meta.main) {
  const base = process.env.GRASP_TEST_BASE;
  await plan(base === undefined || base === "" ? undefined : base);
}
