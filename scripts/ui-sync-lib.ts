// What `packages/ui` must hold for the Damsko items it installed, read
// from Damsko's own registry.json at the pinned commit (ui-sync.ts), and
// the files changed here on purpose (local-changes.json).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { z } from "zod";

/** The registry's namespace in a product's components.json. */
export const namespace = "@damsko";

/** The folder of `packages/ui` every registry file lands in. */
const installRoot = "~/";

/**
 * How a font travels: the shadcn CLI carries text only, so Damsko's
 * registry gives each font as base64 under this name, and the script
 * installed beside them (`fontsUnpack`) writes the font and removes the
 * text. What `packages/ui` holds is the font.
 */
const packedFont = /\.woff2\.base64$/u;

/** Damsko's script that unpacks the fonts, by its path in `packages/ui`. */
export const fontsUnpack = "src/styles/fonts/unpack.mjs";

/** Where a registry file stands in `packages/ui` once installed. */
const installedPath = (target: string): string =>
  target.slice(installRoot.length).replace(packedFont, ".woff2");

const registrySchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      dependencies: z.array(z.string()).default([]),
      devDependencies: z.array(z.string()).default([]),
      registryDependencies: z.array(z.string()).default([]),
      files: z.array(z.object({ path: z.string(), target: z.string() })),
    })
  ),
});

export type Registry = z.infer<typeof registrySchema>;

export const parseRegistry = (json: string): Registry =>
  registrySchema.parse(JSON.parse(json));

export const pinSchema = z.object({
  /** The commit of grasplabs/damsko every file equals. */
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
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
      if (!file.target.startsWith(installRoot)) {
        throw new Error(
          `${name}: ${file.path} has the target "${file.target}", not one under ${installRoot}.`
        );
      }
      files.set(installedPath(file.target), file.path);
    }
    for (const dependency of [...item.dependencies, ...item.devDependencies]) {
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
  readonly read: (path: string) => Uint8Array | undefined;
  /** Every file under `packages/ui/src`, by its path in `packages/ui`. */
  readonly sources: readonly string[];
  /** `packages/ui/package.json`'s dependencies, its dev ones too, each with its version. */
  readonly dependencies: Readonly<Record<string, string>>;
}

const same = (one: Uint8Array, other: Uint8Array): boolean =>
  one.length === other.length &&
  one.every((byte, index) => byte === other[index]);

export const localChangesSchema = z.array(
  z.object({
    /** The file, by its path in `packages/ui`. */
    path: z.string().startsWith("src/"),
    /** Why it differs from Damsko's, in a line. */
    reason: z.string().min(1),
    /** The day it was listed, YYYY-MM-DD. */
    since: z.iso.date(),
    /** Damsko's pull request that carries it, once there is one. */
    pullRequest: z.url().optional(),
  })
);

export type LocalChange = z.infer<typeof localChangesSchema>[number];

/** Days a change may stay here with no pull request in Damsko. */
const unproposedDays = 14;
const dayMs = 86_400_000;

/**
 * Where `packages/ui` is not Damsko's at the pinned commit, one line each:
 * a file missing, changed or not Damsko's that local-changes.json doesn't
 * list, a listed file that no longer differs, and a package an item names
 * that the package doesn't take from the catalog.
 */
export const differences = (
  expected: Expected,
  damsko: (path: string) => Uint8Array,
  installed: Installed,
  local: readonly LocalChange[] = []
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
  for (const [path, source] of expected.files) {
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
  for (const { path } of local) {
    if (!differing.has(path)) {
      found.push(
        `local-changes.json lists ${path}, which no longer differs from Damsko's: remove the entry`
      );
    }
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

/** Listed changes with no pull request in Damsko after two weeks, one line each. */
export const unproposed = (
  local: readonly LocalChange[],
  today: Date
): string[] =>
  local
    .filter(
      ({ since, pullRequest }) =>
        pullRequest === undefined &&
        today.getTime() - Date.parse(since) > unproposedDays * dayMs
    )
    .map(
      ({ path, since }) =>
        `local-changes.json: ${path} has differed from Damsko's since ${since} with no pull request there (vp run ui:propose)`
    );

/** A file's bytes, or undefined where there is none. */
export type Content = Uint8Array | undefined;

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

export const readLocalChanges = (file: string): LocalChange[] =>
  localChangesSchema.parse(JSON.parse(readFileSync(file, "utf-8")));
