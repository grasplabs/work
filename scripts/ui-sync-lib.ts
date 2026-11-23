// What `packages/ui` must hold for the Damsko items it installed, read
// from Damsko's own registry.json at the pinned commit (ui-sync.ts), the
// files changed here on purpose (local-changes.json), and the three ways
// they move: the pin fetched, the package installed again, the changes
// proposed to Damsko.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { z } from "zod";

/** The registry's namespace in a product's components.json. */
export const namespace = "@damsko";

/** The folder of `packages/ui` every registry file lands in. */
const installRoot = "~/";

/** The folder of `packages/ui` that holds Damsko's files. */
const sourceRoot = "src/";

/**
 * How a font travels: the shadcn CLI carries text only, so Damsko's
 * registry gives each font as base64 under this name, and the script
 * installed beside them (`fontsUnpack`) writes the font and removes the
 * text. What `packages/ui` holds is the font.
 */
const packedFont = /\.woff2\.base64$/u;

/** The folder of the fonts item, by its path in `packages/ui`. */
const fontsFolder = "src/styles/fonts/";

/** Damsko's script that unpacks the fonts, by its path in `packages/ui`. */
export const fontsUnpack = `${fontsFolder}unpack.mjs`;

/**
 * A path as every input here names a file: relative, `/` between
 * segments, each segment letters, digits and `._@+-`, never starting with
 * a dot. So no `..`, no `.`, no absolute path, no `~`, no `\`, no `%` and
 * no empty segment: nothing a join or a shell could read as another place.
 */
const plainPath = /^(?:[\w@+-][\w.@+-]*\/)*[\w@+-][\w.@+-]*$/u;

export const isPlainPath = (path: string): boolean => plainPath.test(path);

/**
 * The one way to a file here, from whatever named it: a listed change, a
 * registry's target or path, a file of the patch. `relative` must be a
 * plain path (above), and no step of it under `root` may be a symbolic
 * link, so what it names is inside `root` after the link is followed
 * too. Returns the absolute path; throws otherwise.
 */
export const within = (root: string, relative: string): string => {
  if (!isPlainPath(relative)) {
    throw new Error(
      `"${relative}" is not a plain path inside ${root}: relative, with / between plain names.`
    );
  }
  const base = realpathSync(root);
  const full = nodePath.join(base, ...relative.split("/"));
  if (!full.startsWith(`${base}${nodePath.sep}`)) {
    throw new Error(`"${relative}" is outside ${root}.`);
  }
  let step = base;
  for (const segment of relative.split("/")) {
    step = nodePath.join(step, segment);
    const stat = lstatSync(step, { throwIfNoEntry: false });
    if (stat === undefined) {
      break;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `"${relative}" goes through a symbolic link in ${root}, which may lead anywhere.`
      );
    }
  }
  return full;
};

/** A file's bytes, or undefined where there is none. */
export type Content = Uint8Array | undefined;

/** A file under `root` by its plain path, or undefined without one. */
export const readWithin = (root: string, relative: string): Content => {
  const file = within(root, relative);
  return existsSync(file) ? readFileSync(file) : undefined;
};

/** Removes a file under `root`, if there is one. */
export const removeWithin = (root: string, relative: string): void => {
  rmSync(within(root, relative), { force: true });
};

/** Writes a file under `root`, with its folders; undefined removes it. */
export const writeWithin = (
  root: string,
  relative: string,
  content: Content
): void => {
  if (content === undefined) {
    removeWithin(root, relative);
    return;
  }
  const file = within(root, relative);
  mkdirSync(nodePath.dirname(file), { recursive: true });
  writeFileSync(file, content);
};

/** Where a registry file stands in `packages/ui` once installed. */
const installedPath = (target: string): string =>
  target.slice(installRoot.length).replace(packedFont, ".woff2");

const registrySchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      dependencies: z.array(z.string()).default([]),
      registryDependencies: z.array(z.string()).default([]),
      files: z.array(z.object({ path: z.string(), target: z.string() })),
    })
  ),
});

export type Registry = z.infer<typeof registrySchema>;

export const parseRegistry = (json: string): Registry =>
  registrySchema.parse(JSON.parse(json));

/** A commit of Damsko, in full. */
const commitPattern = /^[0-9a-f]{40}$/u;

/** A release tag of Damsko: `v<major>.<minor>.<patch>`, maybe with a pre-release. */
const releaseTag = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u;

export const pinSchema = z.object({
  /** The commit of grasplabs/damsko every file equals. */
  commit: z.string().regex(commitPattern),
  /** The items added by name; the items they build on come with them. */
  items: z.array(z.string()).min(1),
});

export type Pin = z.infer<typeof pinSchema>;

export interface Expected {
  /** Each installed file: its path in `packages/ui`, and in Damsko. */
  readonly files: ReadonlyMap<string, string>;
  /** The npm packages the installed items name. */
  readonly dependencies: ReadonlySet<string>;
}

/** The items a product added, with every item they build on. */
export const expectedOf = (
  registry: Registry,
  items: readonly string[]
): Expected => {
  const byName = new Map(registry.items.map((item) => [item.name, item]));
  const files = new Map<string, string>();
  const dependencies = new Set<string>();
  const seen = new Set<string>();
  const queue = [...items];
  for (const name of queue) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const item = byName.get(name);
    if (!item) {
      throw new Error(`Damsko's registry has no item "${name}".`);
    }
    for (const file of item.files) {
      const installed = file.target.startsWith(installRoot)
        ? installedPath(file.target)
        : undefined;
      if (
        installed === undefined ||
        !isPlainPath(installed) ||
        !installed.startsWith(sourceRoot)
      ) {
        throw new Error(
          `${name}: ${file.path} has the target "${file.target}", not a plain path under ${installRoot}${sourceRoot}.`
        );
      }
      if (!isPlainPath(file.path)) {
        throw new Error(
          `${name}: "${file.path}" is not a plain path in Damsko.`
        );
      }
      files.set(installed, file.path);
    }
    for (const dependency of item.dependencies) {
      dependencies.add(dependency);
    }
    for (const dependency of item.registryDependencies) {
      if (!dependency.startsWith(`${namespace}/`)) {
        throw new Error(
          `${name} builds on "${dependency}", which is not in ${namespace}.`
        );
      }
      queue.push(dependency.slice(namespace.length + 1));
    }
  }
  return { files, dependencies };
};

export interface Installed {
  /** A file of `packages/ui`, by its path there, or undefined without one. */
  readonly read: (path: string) => Content;
  /** Every file under `packages/ui/src`, by its path in `packages/ui`. */
  readonly sources: readonly string[];
  /** Every symbolic link under `packages/ui/src`, which is never followed. */
  readonly links: readonly string[];
  /** `packages/ui/package.json`'s dependencies, each with its version. */
  readonly dependencies: Readonly<Record<string, string>>;
}

/** The files and links under `root`'s `src/`, by their paths from `root`. */
export const treeOf = (
  root: string
): Pick<Installed, "read" | "sources" | "links"> => {
  const sources: string[] = [];
  const links: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(nodePath.join(root, folder), {
      withFileTypes: true,
    })) {
      const path = `${folder}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        links.push(path);
      } else if (entry.isDirectory()) {
        walk(path);
      } else {
        sources.push(path);
      }
    }
  };
  const top = lstatSync(nodePath.join(root, "src"), { throwIfNoEntry: false });
  if (top !== undefined && top.isSymbolicLink()) {
    links.push("src");
  } else if (top !== undefined && top.isDirectory()) {
    walk("src");
  }
  return { read: (path) => readWithin(root, path), sources, links };
};

const same = (one: Uint8Array, other: Uint8Array): boolean =>
  one.length === other.length &&
  one.every((byte, index) => byte === other[index]);

export const localChangesSchema = z.array(
  z.object({
    /** The file, by its path in `packages/ui`. */
    path: z
      .string()
      .refine(isPlainPath, {
        error:
          "must be a plain path in packages/ui: relative, with / between plain names, no .. or ~",
      })
      .refine((path) => path.startsWith(sourceRoot), {
        error: `must be a file under packages/ui/${sourceRoot}`,
      })
      .refine((path) => !path.startsWith(fontsFolder), {
        error: `can't be a font file (${fontsFolder}): the fonts are Damsko's as it ships them, each held to its checksum in SHA256SUMS; change them in Damsko`,
      }),
    /** Why it differs from Damsko's, in a line. */
    reason: z.string().min(1),
    /** The day it was listed, YYYY-MM-DD. */
    since: z.iso.date(),
    /** Damsko's pull request that carries it, once there is one. */
    pullRequest: z.url().optional(),
  })
);

export type LocalChange = z.infer<typeof localChangesSchema>[number];

/** Days a change may stay here before check:ui names it. */
const overdueDays = 14;
const dayMs = 86_400_000;

/** The day a date falls on in UTC, as `since` gives it. */
const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Where `packages/ui` is not Damsko's at the pinned commit, one line each:
 * a symbolic link, a file missing, changed or not Damsko's that
 * local-changes.json doesn't list, a listed file that no longer differs or
 * never was, an entry dated after today, and a package an item names that
 * the package doesn't take from the catalog.
 */
export const differences = (
  expected: Expected,
  damsko: (path: string) => Uint8Array,
  installed: Installed,
  local: readonly LocalChange[] = [],
  today = new Date()
): string[] => {
  const found: string[] = [];
  const listed = new Set(local.map((change) => change.path));
  const differing = new Set<string>();
  const differs = (path: string, line: string): void => {
    differing.add(path);
    if (!listed.has(path)) {
      found.push(line);
    }
  };
  const linked = (path: string): boolean =>
    installed.links.some(
      (link) => path === link || path.startsWith(`${link}/`)
    );
  for (const link of installed.links) {
    found.push(
      `${link} is a symbolic link: packages/ui holds Damsko's files themselves, so a link is never followed and can't be listed`
    );
  }
  for (const [path, source] of expected.files) {
    if (linked(path)) {
      continue;
    }
    const ours = installed.read(path);
    if (!ours) {
      differs(path, `${path} is missing`);
    } else if (!same(ours, damsko(source))) {
      differs(path, `${path} differs from Damsko's ${source}`);
    }
  }
  for (const path of installed.sources) {
    if (!expected.files.has(path)) {
      differs(path, `${path} is no file of the installed items`);
    }
  }
  // Today anywhere on Earth: a day listed where it is already tomorrow
  // (UTC+14) is no day after today, though CI's clock is UTC's.
  const latestToday = dayOf(new Date(today.getTime() + 14 * 3_600_000));
  for (const { path, since } of local) {
    if (since > latestToday) {
      found.push(
        `local-changes.json dates ${path} ${since}, after today: give the day it was listed`
      );
    }
    if (linked(path) || differing.has(path)) {
      continue;
    }
    found.push(
      expected.files.has(path) || installed.read(path) !== undefined
        ? `local-changes.json lists ${path}, which no longer differs from Damsko's: remove the entry`
        : `local-changes.json lists ${path}, which neither Damsko's items nor packages/ui has: remove the entry`
    );
  }
  for (const name of expected.dependencies) {
    if (installed.dependencies[name] !== "catalog:") {
      found.push(
        `package.json: ${name} must be a dependency at "catalog:", and is ${JSON.stringify(installed.dependencies[name])}`
      );
    }
  }
  return found;
};

/**
 * Listed changes older than two weeks, one line each: one with no pull
 * request in Damsko yet, and one whose pull request hasn't reached the pin.
 */
export const overdue = (local: readonly LocalChange[], today: Date): string[] =>
  local
    .filter(
      ({ since }) => today.getTime() - Date.parse(since) > overdueDays * dayMs
    )
    .map(({ path, since, pullRequest }) =>
      pullRequest === undefined
        ? `local-changes.json: ${path} has differed from Damsko's since ${since} with no pull request there (vp run ui:propose)`
        : `local-changes.json: ${path} has differed from Damsko's since ${since}; once ${pullRequest} merges, move the pin there (vp run ui:update <commit>)`
    );

const git = (cwd: string, ...args: string[]): string => {
  const run = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (run.error || run.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${run.stderr || String(run.error)}`
    );
  }
  return run.stdout;
};

const succeeds = (cwd: string, ...args: string[]): boolean =>
  spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0;

/**
 * Damsko's tree at a commit or release tag, checked out into `into`, a
 * folder that doesn't exist yet. Only what Damsko merged or released is
 * fetched: the commit must be on its `main` or be what a release tag
 * (`v1.2.3`) points at. Anything else a remote serves by its hash, as
 * GitHub does a pull request's head and a fork's commits, is refused
 * before a file of it is read. Returns the commit.
 */
export const fetchDamsko = (
  repository: string,
  commitOrTag: string,
  into: string
): string => {
  if (!commitPattern.test(commitOrTag) && !releaseTag.test(commitOrTag)) {
    throw new Error(
      `"${commitOrTag}" is neither a commit of Damsko in full (40 hex digits) nor a release tag (v1.2.3).`
    );
  }
  mkdirSync(into, { recursive: true });
  git(into, "init", "--quiet");
  git(into, "remote", "add", "origin", repository);
  // Its main's history and its tags, without the files: a checkout of
  // the one commit fetches those.
  git(
    into,
    "fetch",
    "--quiet",
    "--filter=blob:none",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
    "+refs/tags/*:refs/tags/*"
  );
  let commit = commitOrTag;
  if (releaseTag.test(commitOrTag)) {
    const tagged = `refs/tags/${commitOrTag}^{commit}`;
    if (!succeeds(into, "rev-parse", "--verify", "--quiet", tagged)) {
      throw new Error(`Damsko has no tag ${commitOrTag}.`);
    }
    commit = git(into, "rev-parse", tagged).trim();
  }
  const onMain =
    succeeds(into, "cat-file", "-e", `${commit}^{commit}`) &&
    succeeds(into, "merge-base", "--is-ancestor", commit, "origin/main");
  const released =
    onMain ||
    git(into, "tag", "--points-at", commit)
      .split("\n")
      .some((tag) => releaseTag.test(tag));
  if (!released) {
    throw new Error(
      `${commit} is neither on Damsko's main nor a release tag of it: pin only what Damsko merged or released.`
    );
  }
  git(into, "checkout", "--quiet", "--detach", commit);
  return commit;
};

/**
 * The listed changes as one patch for Damsko. `damsko` is a git checkout
 * of its tree at the pin; `files` holds each changed file by its path
 * there, with this repository's content, undefined where it was removed
 * here. Writes them into the checkout and returns git's binary diff of it.
 */
export const proposal = (
  damsko: string,
  files: ReadonlyMap<string, Content>
): string => {
  for (const [file, content] of files) {
    writeWithin(damsko, file, content);
  }
  git(damsko, "add", "--all");
  return git(damsko, "diff", "--cached", "--binary");
};

/** What a re-pin does with a listed change. */
export type Carried =
  | { readonly kind: "dropped" }
  | { readonly kind: "kept"; readonly content: Content }
  | { readonly kind: "conflict"; readonly content: Uint8Array };

const sameContent = (one: Content, other: Content): boolean =>
  one === undefined || other === undefined ? one === other : same(one, other);

/**
 * Three-way merge with git's own: Damsko's change from `base` to `theirs`
 * on top of this repository's from `base` to `ours`. A conflict is in the
 * content as git marks it.
 */
export const merge = (
  base: Uint8Array,
  ours: Uint8Array,
  theirs: Uint8Array
): { content: Uint8Array; clean: boolean } => {
  const folder = mkdtempSync(nodePath.join(tmpdir(), "damsko-merge-"));
  try {
    const files = { ours, base, theirs };
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(nodePath.join(folder, name), content);
    }
    const run = spawnSync(
      "git",
      [
        "merge-file",
        "-p",
        "-L",
        "here",
        "-L",
        "pinned",
        "-L",
        "Damsko",
        "ours",
        "base",
        "theirs",
      ],
      { cwd: folder }
    );
    // Its status is the number of conflicts, at most 127; above, it failed.
    if (run.error || run.status === null || run.status > 127) {
      throw new Error(`git merge-file failed: ${run.stderr.toString()}`);
    }
    return { content: run.stdout, clean: run.status === 0 };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

/**
 * A listed change at a new pin: dropped once Damsko's file is ours, kept
 * where Damsko left the file as it was, else Damsko's change merged under
 * ours, or a conflict to resolve by hand. `was` is Damsko's file at the old
 * pin, `now` at the new one, `ours` this repository's, each undefined
 * where there is none.
 */
export const carry = ({
  was,
  now,
  ours,
}: {
  readonly was?: Content;
  readonly now?: Content;
  readonly ours?: Content;
}): Carried => {
  if (sameContent(now, ours)) {
    return { kind: "dropped" };
  }
  if (sameContent(was, now) || ours === undefined) {
    return { kind: "kept", content: ours };
  }
  if (now === undefined) {
    return { kind: "conflict", content: ours };
  }
  const merged = merge(was ?? new Uint8Array(), ours, now);
  return merged.clean
    ? { kind: "kept", content: merged.content }
    : { kind: "conflict", content: merged.content };
};

/** local-changes.json's entries; refused, with each reason, where one isn't right. */
export const readLocalChanges = (file: string): LocalChange[] => {
  const parsed = localChangesSchema.safeParse(
    JSON.parse(readFileSync(file, "utf-8"))
  );
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map(
          (issue) =>
            `local-changes.json, ${issue.path.map(String).join(".")}: ${issue.message}`
        )
        .join("\n")
    );
  }
  return parsed.data;
};

/** Damsko's tree at a pin: its checkout, and what the pinned items install. */
export interface DamskoAt {
  readonly root: string;
  readonly expected: Expected;
}

/** Damsko's file for one of `packages/ui`: by the registry's map, else at the same path. */
export const damskoPath = (expected: Expected, file: string): string =>
  expected.files.get(file) ?? file;

export interface UpdateInput {
  /** `packages/ui`. */
  readonly ui: string;
  /**
   * Installs every pinned item into `stage`, an empty folder standing for
   * `packages/ui`, as `packages/ui` stands in a folder of its own (the
   * one two above it, for the workspace's files the CLI reads): its
   * `src/` is what the CLI writes, fonts unpacked.
   */
  readonly install: (stage: string) => Promise<void>;
  /** Damsko at the pin this package is at, and at the new one. */
  readonly was: DamskoAt;
  readonly now: DamskoAt;
  readonly local: readonly LocalChange[];
  /** `damsko.json` as it is to be once the update holds. */
  readonly pin: string;
  /** `packages/ui/package.json`'s dependencies. */
  readonly dependencies: Readonly<Record<string, string>>;
  readonly today?: Date;
}

export interface Updated {
  /** The listed files left with git's conflict markers. */
  readonly conflicts: readonly string[];
  /** The entries dropped, as Damsko's file is now the same. */
  readonly dropped: readonly string[];
}

/**
 * Puts `stage/src` in the place of `ui/src`, and the given files beside
 * it: the new `src/` is first copied next to the old, so the swap is two
 * renames. Whatever fails puts back what was.
 */
const swap = (
  ui: string,
  stage: string,
  files: Readonly<Record<string, string>>
): void => {
  const aside = mkdtempSync(nodePath.join(ui, ".update-"));
  const next = nodePath.join(aside, "next");
  const before = nodePath.join(aside, "before");
  const source = nodePath.join(ui, "src");
  const kept = Object.fromEntries(
    Object.keys(files).map((name) => [name, readWithin(ui, name)] as const)
  );
  let moved = false;
  let placed = false;
  try {
    cpSync(nodePath.join(stage, "src"), next, {
      recursive: true,
      verbatimSymlinks: true,
    });
    if (existsSync(source)) {
      renameSync(source, before);
      moved = true;
    }
    renameSync(next, source);
    placed = true;
    for (const [name, content] of Object.entries(files)) {
      writeWithin(ui, name, new TextEncoder().encode(content));
    }
  } catch (error) {
    if (placed) {
      rmSync(source, { recursive: true, force: true });
    }
    if (moved) {
      renameSync(before, source);
    }
    for (const [name, content] of Object.entries(kept)) {
      writeWithin(ui, name, content);
    }
    throw error;
  } finally {
    rmSync(aside, { recursive: true, force: true });
  }
};

/**
 * Installs the pin again, all or nothing. The new `src/` is built in a
 * folder of its own: installed there, each listed change carried over (the
 * file as it is here, Damsko's at the old pin and at the new one), then
 * checked as check:ui checks. Only then does it take the place of
 * `packages/ui/src`, with `damsko.json` and `local-changes.json`; on any
 * failure before or during that, `packages/ui` is as it was. A conflict is
 * no failure: the file is left with git's markers, to resolve by hand.
 */
export const updateTree = async (input: UpdateInput): Promise<Updated> => {
  const { ui, was, now, local } = input;
  // Read before anything moves: a listed path that isn't plain, or goes
  // through a link, stops the update here.
  const ours = new Map(
    local.map(({ path }) => [path, readWithin(ui, path)] as const)
  );
  const scratch = mkdtempSync(nodePath.join(tmpdir(), "damsko-update-"));
  try {
    const stage = nodePath.join(scratch, "packages", "ui");
    mkdirSync(stage, { recursive: true });
    await input.install(stage);
    const conflicts: string[] = [];
    const dropped: string[] = [];
    const remaining = local.filter(({ path }) => {
      const carried = carry({
        was: readWithin(was.root, damskoPath(was.expected, path)),
        now: readWithin(now.root, damskoPath(now.expected, path)),
        ours: ours.get(path),
      });
      if (carried.kind === "dropped") {
        dropped.push(path);
        return false;
      }
      writeWithin(stage, path, carried.content);
      if (carried.kind === "conflict") {
        conflicts.push(path);
      }
      return true;
    });
    const found = differences(
      now.expected,
      (file) => {
        const content = readWithin(now.root, file);
        if (content === undefined) {
          throw new Error(`Damsko has no ${file} at the new pin.`);
        }
        return content;
      },
      { ...treeOf(stage), dependencies: input.dependencies },
      remaining,
      input.today
    );
    if (found.length > 0) {
      throw new Error(
        `The new install is not Damsko's; packages/ui is left as it was:\n${found.join("\n")}`
      );
    }
    swap(ui, stage, {
      "damsko.json": input.pin,
      "local-changes.json": `${JSON.stringify(remaining, null, 2)}\n`,
    });
    return { conflicts, dropped };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
