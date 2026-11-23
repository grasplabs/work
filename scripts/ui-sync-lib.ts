// What `packages/ui` must hold for the Damsko items it installed, read
// from Damsko's own registry.json at the pinned commit (ui-sync.ts).
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
  readonly read: (path: string) => Uint8Array | undefined;
  /** Every file under `packages/ui/src`, by its path in `packages/ui`. */
  readonly sources: readonly string[];
  /** `packages/ui/package.json`'s dependencies, each with its version. */
  readonly dependencies: Readonly<Record<string, string>>;
}

const same = (one: Uint8Array, other: Uint8Array): boolean =>
  one.length === other.length &&
  one.every((byte, index) => byte === other[index]);

/**
 * Where `packages/ui` is not Damsko's at the pinned commit, one line each:
 * a file missing, changed or not Damsko's, and a package an item names
 * that the package doesn't take from the catalog.
 */
export const differences = (
  expected: Expected,
  damsko: (path: string) => Uint8Array,
  installed: Installed
): string[] => {
  const found: string[] = [];
  for (const [path, source] of expected.files) {
    const ours = installed.read(path);
    if (!ours) {
      found.push(`${path} is missing`);
    } else if (!same(ours, damsko(source))) {
      found.push(`${path} differs from Damsko's ${source}`);
    }
  }
  for (const path of installed.sources) {
    if (!expected.files.has(path)) {
      found.push(`${path} is no file of the installed items`);
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
