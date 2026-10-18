/**
 * Turns a definition package (`@grasp-os/shared/definition-packages`, what
 * core's `apps.definition` exports) into a standalone project a developer
 * builds outside Grasp: the App's source with the references generated
 * from its sealed registration, the workflow versions it binds, and the
 * checkout's own SDK, UI kit and shared packages under `vendor/`, with
 * their licence and the notices of every direct dependency.
 *
 * Threat model (GRA-713), and how each is closed:
 *
 * - A package's file path writes outside where it belongs, or where a tool
 *   reads it: every path is checked before anything is written
 *   (`safePath`): relative, `/` separated, at most 255 bytes a segment, no
 *   empty, `.` or `..` segment, no separator, drive, colon or control
 *   character, no trailing dot or space, no name Windows reserves, and no
 *   `.git`, `.npmrc` or `.vscode`; and each lands inside its subtree once
 *   resolved. Two paths the same once folded (NFC, full case folding) are
 *   refused, as is an App file where the references are generated.
 * - It writes through something already there, or leaves half a project:
 *   the whole project is planned and checked first, then built in a new
 *   directory beside `--out`, each file created anew (`wx`), and renamed
 *   onto `--out` only while that is missing or an empty directory, never
 *   a link.
 * - The package isn't one the platform made, or for another SDK protocol:
 *   it is parsed with the strict package schema, its registration with
 *   the SDK's strict reader, and a protocol other than the checkout's is
 *   refused.
 * - Packages are fetched that nothing pinned, or replace one the project
 *   pins, or the network is reached: nothing here makes a network call.
 *   What is pinned exactly: the App's direct dependencies and, as npm
 *   `overrides`, each of its locked packages' dependencies, from its own
 *   lock, and the same of each workflow version's approved packages,
 *   from the lock its entry carries; two locks that pin one package at
 *   different versions are refused, as is a workflow that imports
 *   packages without a lock, since a project installs one of each
 *   (GRA-737); the vendored packages' and the project's own direct
 *   dependencies, from the catalog. What isn't: the catalog packages' own
 *   dependencies, which the package manager resolves at install, and
 *   integrity, which only a lockfile carries. A lock that names a package
 *   the project pins itself (Grasp's scope, React, the type-checker),
 *   anywhere in its graph but its peers, is refused. Installing is the
 *   developer's step, after.
 * - Code from the package runs: none does. The references are generated
 *   from the registration as data (`generateModules`).
 * - Licences: the vendored packages ship with their AGPL-3.0 text, and the
 *   notices list each direct dependency with the licence its lock or
 *   installed package declares when it reads as an SPDX expression,
 *   "unknown" otherwise.
 * - It checks outside Grasp but fails on it, or the other way round: each
 *   kind of code gets a tsconfig of the compiler's own options for it
 *   (`planTypeCheck`), the project pins the compiler's TypeScript, and its
 *   check is the compiler's (standalone-check.ts), which refuses what the
 *   platform's build refuses before its check.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  generateModules,
  readAppManifest,
  readSealedWorkflows,
} from "@grasp-os/sdk/host";
import { sdkProtocolVersion } from "@grasp-os/shared/app-releases";
import { definitionPackageSchema } from "@grasp-os/shared/definition-packages";
import type { DefinitionPackage } from "@grasp-os/shared/definition-packages";
import { graspLockSchema } from "@grasp-os/shared/packages";
import type { GraspLock, LockedPackage } from "@grasp-os/shared/packages";
import { z } from "zod";

import { screenReferences } from "../packages/compiler/src/kit.ts";
import { tsconfigOptions } from "../packages/compiler/src/tsconfig.ts";
import {
  appCodeTarget,
  compilerOptions,
  computeTarget,
  generatedTarget,
  workflowTarget,
} from "../packages/compiler/src/type-check.ts";
import type { TypeTarget } from "../packages/compiler/src/type-check.ts";

/** The workspace packages a project vendors, each with what it depends on. */
const vendored = ["shared", "sdk", "ui"] as const;

/** The catalog packages every project depends on itself. */
const projectDependencies = ["react", "react-dom"] as const;
const projectDevDependencies = [
  "typescript",
  "@types/react",
  "@types/react-dom",
] as const;

/** The identity the generated references carry: no deployment's own. */
const localIdentity = "local";

/** Why packaging refused, naming what, never a file's contents. */
export class PackagingError extends Error {
  override readonly name = "PackagingError";
}

const refuse = (message: string): never => {
  throw new PackagingError(message);
};

const drivePattern = /^[A-Za-z]:/u;
const workflowKeyPattern =
  /^workspace\/(?<name>[a-z0-9-]+)\/(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u;

/** Characters no segment holds: separators, Windows' reserved, controls. */
// oxlint-disable-next-line no-control-regex -- control characters are what it refuses
const forbiddenCharacters = /[\\/:*?"<>|\u0000-\u001F\u007F]/u;
/** Names Windows reserves for devices, with or without an extension. */
const reservedName = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/u;
/** Segments that configure a tool or repository when written anywhere. */
const toolSegments: ReadonlySet<string> = new Set([
  ".git",
  ".npmrc",
  ".vscode",
]);
const encoder = new TextEncoder();

/**
 * `text` folded as file systems that ignore case compare names: NFC, then
 * full case folding (`ſ` as `s`, `ß` as `ss`) by way of upper case.
 */
export const folded = (text: string): string =>
  text.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");

/**
 * `relative` as a path inside a project subtree: `/`-separated segments,
 * at most 512 characters, refusing anything else, naming `where`. No
 * segment is empty, `.` or `..`; holds a separator, colon, character
 * Windows reserves or control character; ends in a dot or space; is a
 * name Windows reserves for a device; is `.git`, `.npmrc` or `.vscode`
 * in any case; or takes more than 255 bytes.
 */
export const safePath = (relative: string, where: string): string => {
  if (
    relative.length === 0 ||
    relative.length > 512 ||
    relative.startsWith("/") ||
    drivePattern.test(relative)
  ) {
    return refuse(`${where}: a file path must be relative.`);
  }
  for (const segment of relative.split("/")) {
    const name = folded(segment);
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      forbiddenCharacters.test(segment) ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      reservedName.test(name) ||
      toolSegments.has(name) ||
      encoder.encode(segment).byteLength > 255
    ) {
      return refuse(`${where}: a file path has a segment it may not have.`);
    }
  }
  return relative;
};

/** A project as planned: every file by its path, before any is written. */
interface Plan {
  readonly files: Map<string, string>;
  /** Adds `text` at `file` (already safe), once, whatever its case. */
  readonly add: (file: string, text: string) => void;
}

const newPlan = (): Plan => {
  const files = new Map<string, string>();
  const seen = new Set<string>();
  return {
    files,
    add: (file, text) => {
      const key = folded(file);
      if (seen.has(key)) {
        refuse(
          `${file}: another file has this path, or one that differs only by case.`
        );
      }
      seen.add(key);
      files.set(file, text);
    },
  };
};

/** `value` as JSON text, as the project's files hold it. */
const jsonText = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

/**
 * The exact versions `pnpm-workspace.yaml`'s catalog pins, by name: its
 * default `catalog:`, or with `named`, that catalog under `catalogs:`.
 */
export const readCatalog = (
  text: string,
  named?: string
): Map<string, string> => {
  const catalog = new Map<string, string>();
  // The default catalog's entries are indented once; a named catalog's
  // once more, under its name.
  let inCatalog = false;
  let inCatalogs = false;
  for (const line of text.split("\n")) {
    if (/^\S/u.test(line)) {
      inCatalog = named === undefined && line.trim() === "catalog:";
      inCatalogs = named !== undefined && line.trim() === "catalogs:";
      continue;
    }
    if (inCatalogs && /^ {2}\S/u.test(line)) {
      inCatalog = line.trim() === `${named}:`;
      continue;
    }
    const entry =
      /^\s+"?(?<name>[^"\s:#][^":]*?)"?:\s*(?<version>\S+)\s*$/u.exec(line);
    if (
      inCatalog &&
      entry?.groups?.name !== undefined &&
      entry.groups.version !== undefined
    ) {
      catalog.set(entry.groups.name, entry.groups.version);
    }
  }
  return catalog;
};

const exactVersionPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** `name`'s exact catalog version, or a refusal. */
const pinned = (catalog: ReadonlyMap<string, string>, name: string): string => {
  const version = catalog.get(name);
  if (version === undefined || !exactVersionPattern.test(version)) {
    return refuse(`${name}: the catalog pins no exact version of it.`);
  }
  return version;
};

/**
 * The TypeScript the platform type-checks App code with: the compiler's
 * own, as its package names it from the catalog (`catalog:typescript6`),
 * exactly. TypeScript 7, the repo's toolchain, has no JavaScript API.
 */
const platformTypescript = (repo: string, catalogText: string): string => {
  const spec = z
    .object({ dependencies: z.object({ typescript: z.string() }) })
    .parse(
      JSON.parse(
        readFileSync(path.join(repo, "packages/compiler/package.json"), "utf-8")
      )
    ).dependencies.typescript;
  const named = /^catalog:(?<name>.*)$/u.exec(spec)?.groups?.name;
  if (named === undefined) {
    return refuse("The compiler names TypeScript by no catalog.");
  }
  return pinned(
    readCatalog(catalogText, named === "" ? undefined : named),
    "typescript"
  );
};

const packageJsonSchema = z.looseObject({
  name: z.string(),
  license: z.string().optional(),
  type: z.string().optional(),
  exports: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
});

/**
 * Every file under `dir`, by path relative to it, sorted: a package's
 * `src/`, which holds what it exports and nothing else (its tests live
 * beside it, in `test/`). A link is skipped, never followed.
 */
const sourcesUnder = (dir: string, prefix = ""): string[] =>
  readdirSync(path.join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        return sourcesUnder(dir, relative);
      }
      return entry.isFile() ? [relative] : [];
    })
    .toSorted();

/** A dependency's licence as its installed package declares it. */
const installedLicence = (
  repo: string,
  from: string,
  name: string
): string | null => {
  for (const dir of [
    path.join(repo, "packages", from, "node_modules"),
    path.join(repo, "node_modules"),
  ]) {
    try {
      const declared: unknown = JSON.parse(
        readFileSync(path.join(dir, name, "package.json"), "utf-8")
      );
      const licence = z
        .object({
          license: z.union([z.string(), z.object({ type: z.string() })]),
        })
        .safeParse(declared);
      if (licence.success) {
        return typeof licence.data.license === "string"
          ? licence.data.license
          : licence.data.license.type;
      }
    } catch {
      // Not installed there: the next place, or unknown.
    }
  }
  return null;
};

/** A dependency the project names, with what its notice says. */
interface Notice {
  readonly name: string;
  readonly version: string;
  readonly licence: string | null;
  readonly from: string;
}

/** What packaging takes: the package, and the checkout it vendors from. */
export interface PackagingInput {
  /** The definition package, as parsed JSON. */
  readonly definition: unknown;
  /** The directory to create the project in. */
  readonly out: string;
  /** The Grasp OS checkout: its packages, catalog and licence. */
  readonly repo: string;
  /** The checkout's commit, recorded with what it vendors. */
  readonly commit: string;
}

/** The package `definition`, of a protocol this checkout runs, or a refusal. */
const readDefinition = (definition: unknown): DefinitionPackage => {
  const parsed = definitionPackageSchema.safeParse(definition);
  if (!parsed.success) {
    return refuse("The file isn't a definition package this checkout reads.");
  }
  const { sdkProtocolVersion: sealed } = parsed.data.app.provenance;
  if (sealed !== sdkProtocolVersion) {
    return refuse(
      `The package was sealed for SDK protocol ${sealed}; this checkout's is ${sdkProtocolVersion}.`
    );
  }
  return parsed.data;
};

/**
 * The App: its source as packaged, and its references generated anew from
 * its sealed registration, with no deployment's identity.
 */
const planApp = async (
  project: Plan,
  app: DefinitionPackage["app"]
): Promise<void> => {
  // What the seal resolved of each packaged workflow, read back as
  // strictly as a release's own contracts are: no pin, so the references
  // name no deployment's workflow.
  const bound = readSealedWorkflows(
    Object.fromEntries(
      Object.entries(app.workflowContracts).map(([alias, contract]) => [
        alias,
        { alias, ...contract },
      ])
    )
  );
  const generated = await generateModules(
    readAppManifest(app.manifest),
    { resourceId: localIdentity, resourceVersion: app.version },
    bound
  );
  for (const [file, text] of Object.entries(generated)) {
    project.add(`app/${safePath(file, "generated")}`, text);
  }
  for (const [file, text] of Object.entries(app.files)) {
    project.add(`app/${safePath(file, "app")}`, text);
  }
};

/** Each workflow version, under its own name and version. */
const planWorkflows = (
  project: Plan,
  workflows: DefinitionPackage["workflows"]
): void => {
  for (const [key, workflow] of Object.entries(workflows)) {
    const groups = workflowKeyPattern.exec(key)?.groups;
    if (groups?.name === undefined || groups.version === undefined) {
      refuse("A workflow's key isn't one a package names workflows by.");
      return;
    }
    const base = `workflows/${groups.name}/${groups.version}`;
    for (const [file, text] of Object.entries(workflow.files)) {
      project.add(`${base}/${safePath(file, key)}`, text);
    }
  }
};

const declaredDependenciesSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
});

/** What a lock pins: its direct dependencies, and theirs. */
interface LockPins {
  readonly direct: Record<string, string>;
  /**
   * npm `overrides`: for each locked package, by `<name>@<version>`, the
   * exact version of each of its dependencies and of each peer met within
   * its graph, as the lock resolved them.
   */
  readonly overrides: Record<string, Record<string, string>>;
}

/**
 * The peers of `entry` the lock resolved within its own graph, by exact
 * version: pinned like its dependencies. Peers the platform meets are the
 * project's own (React), which it pins itself.
 */
const graphPeersOf = (entry: LockedPackage): Record<string, string> =>
  Object.fromEntries(
    Object.entries(entry.peers).flatMap(([name, peer]) =>
      peer.by === "graph" && peer.resolved !== null
        ? [[name, peer.resolved]]
        : []
    )
  );

/** Whether the project pins `name` itself, so no App lock may name it. */
const ownedByProject = (name: string): boolean =>
  name.startsWith("@grasp-os/") ||
  projectDependencies.some((each) => each === name) ||
  projectDevDependencies.some((each) => each === name);

/**
 * What `lock`, `owner`'s, pins: its direct dependencies exactly as it
 * resolved them, and each locked package's dependencies as overrides, each
 * direct one in the notices. A lock that names one the project pins itself
 * (the vendored packages, React, the type-checker) is refused: it would
 * swap it for whatever the registry serves.
 */
const lockPins = (
  lock: Omit<GraspLock, "artifacts">,
  owner: string,
  notices: Notice[]
): LockPins => {
  const locked = Object.values(lock.packages);
  // Nothing the project pins itself is the lock's to replace, anywhere in
  // the graph but its peers, which the project's own versions meet.
  const named = locked.flatMap((entry) => [
    entry.name,
    ...Object.keys(entry.dependencies),
    ...Object.keys(graphPeersOf(entry)),
  ]);
  if (
    Object.keys(lock.direct).some(ownedByProject) ||
    named.some(ownedByProject)
  ) {
    refuse(
      `${owner.charAt(0).toUpperCase()}${owner.slice(1)}'s lock names a package the project pins itself.`
    );
  }
  for (const [name, version] of Object.entries(lock.direct)) {
    notices.push({
      name,
      version,
      licence:
        locked.find((entry) => entry.name === name && entry.version === version)
          ?.license ?? null,
      from: `${owner}'s lock`,
    });
  }
  const overrides: Record<string, Record<string, string>> = {};
  for (const entry of locked) {
    const pinnedEdges = { ...graphPeersOf(entry), ...entry.dependencies };
    if (Object.keys(pinnedEdges).length > 0) {
      overrides[`${entry.name}@${entry.version}`] = pinnedEdges;
    }
  }
  return { direct: { ...lock.direct }, overrides };
};

/** The App's own dependencies, as its lock pins them (`lockPins`). */
const appDependencies = (
  files: Readonly<Record<string, string>>,
  notices: Notice[]
): LockPins => {
  const lockText = files["grasp.lock.json"];
  if (lockText === undefined) {
    const declared =
      files["package.json"] === undefined
        ? {}
        : declaredDependenciesSchema.parse(JSON.parse(files["package.json"]))
            .dependencies;
    if (Object.keys(declared ?? {}).length > 0) {
      refuse("The App declares dependencies but carries no lock for them.");
    }
    return { direct: {}, overrides: {} };
  }
  const lock = graspLockSchema.safeParse(JSON.parse(lockText));
  if (!lock.success) {
    return refuse(
      "The App's grasp.lock.json isn't a lock this checkout reads."
    );
  }
  return lockPins(lock.data, "the App", notices);
};

/**
 * Each workflow version's approved packages, as the lock its entry
 * carries pins them (`lockPins`): one that imports packages without a
 * lock is refused, since nothing would pin what its modules import.
 */
const workflowDependencies = (
  workflows: DefinitionPackage["workflows"],
  notices: Notice[]
): { owner: string; pins: LockPins }[] =>
  Object.entries(workflows)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .flatMap(([key, { packages }]) => {
      if (packages === null) {
        return [];
      }
      if (packages.lock === null) {
        return refuse(
          `${key} imports packages, but the package carries no lock for them.`
        );
      }
      return [{ owner: key, pins: lockPins(packages.lock, key, notices) }];
    });

/** A locked package's pinned edges, by name, as one text to compare. */
const edgesText = (edges: Readonly<Record<string, string>>): string =>
  JSON.stringify(
    Object.entries(edges).toSorted(([a], [b]) => (a < b ? -1 : 1))
  );

/**
 * One project's pins of every lock in `all`: a package pinned at two
 * versions, directly or in what one locked package depends on, is
 * refused, since the project installs one of it.
 */
const mergedPins = (all: readonly { owner: string; pins: LockPins }[]) => {
  const direct: Record<string, string> = {};
  const directBy: Record<string, string> = {};
  const overrides: Record<string, Record<string, string>> = {};
  for (const { owner, pins } of all) {
    for (const [name, version] of Object.entries(pins.direct)) {
      const before = direct[name];
      if (before !== undefined && before !== version) {
        refuse(
          `${name} is pinned at ${before} by ${directBy[name] ?? "another lock"} and at ${version} by ${owner}; a project installs one.`
        );
      }
      direct[name] = version;
      directBy[name] ??= owner;
    }
    for (const [locked, edges] of Object.entries(pins.overrides)) {
      const before = overrides[locked];
      if (before !== undefined && edgesText(before) !== edgesText(edges)) {
        refuse(`${locked} depends on other versions in ${owner}'s lock.`);
      }
      overrides[locked] = edges;
    }
  }
  return { direct, overrides };
};

/** What a vendored package needs from the checkout. */
interface Vendoring {
  readonly repo: string;
  readonly catalog: ReadonlyMap<string, string>;
  readonly version: string;
  readonly notices: Notice[];
}

/** `name`'s dependencies, pinned: siblings by path, the rest by the catalog. */
const pinnedDependenciesOf = (
  name: string,
  manifest: z.infer<typeof packageJsonSchema>,
  vendoring: Vendoring
): Record<string, string> => {
  const pinnedDependencies: Record<string, string> = {};
  for (const [dependency, spec] of Object.entries(
    manifest.dependencies ?? {}
  )) {
    const sibling = dependency.replace("@grasp-os/", "");
    if (spec === "workspace:*" && vendored.some((each) => each === sibling)) {
      pinnedDependencies[dependency] = `file:../${sibling}`;
    } else if (spec === "catalog:") {
      const version = pinned(vendoring.catalog, dependency);
      pinnedDependencies[dependency] = version;
      vendoring.notices.push({
        name: dependency,
        version,
        licence: installedLicence(vendoring.repo, name, dependency),
        from: manifest.name,
      });
    } else {
      refuse(
        `${manifest.name} names ${dependency} by a version this can't pin.`
      );
    }
  }
  return pinnedDependencies;
};

/** The checkout's package `name`, vendored: its sources and pinned manifest. */
const planVendored = (
  project: Plan,
  name: (typeof vendored)[number],
  vendoring: Vendoring
): void => {
  const dir = path.join(vendoring.repo, "packages", name);
  const manifest = packageJsonSchema.parse(
    JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8"))
  );
  // Only what the vendored sources serve: entries outside `src/` (the UI
  // kit's catalog, the SDK's test fixture) stay behind.
  const exports = Object.fromEntries(
    Object.entries(manifest.exports ?? {}).filter(([, target]) =>
      target.startsWith("./src/")
    )
  );
  const base = `vendor/@grasp-os/${name}`;
  project.add(
    `${base}/package.json`,
    jsonText({
      name: manifest.name,
      version: vendoring.version,
      private: true,
      license: manifest.license,
      type: manifest.type,
      exports,
      dependencies: pinnedDependenciesOf(name, manifest, vendoring),
      ...(manifest.peerDependencies === undefined
        ? {}
        : { peerDependencies: manifest.peerDependencies }),
    })
  );
  for (const file of sourcesUnder(path.join(dir, "src"))) {
    project.add(
      `${base}/src/${file}`,
      readFileSync(path.join(dir, "src", file), "utf-8")
    );
  }
};

/**
 * Where the compiler's check of a standalone project is: the check itself
 * and what it reads of the platform's own steering refusals, each written
 * as the compiler has it (standalone-check.ts).
 */
const compilerSource = "packages/compiler/src";
const checkFiles = {
  "grasp/check.ts": "standalone-check.ts",
  "grasp/steering.ts": "steering.ts",
} as const;

/** Server code as spec 8 lays it out, as the platform's check reads it. */
const serverCodeIncludes = [
  "app.ts",
  "schema.ts",
  "values.ts",
  "operations/**/*.ts",
  "migrations/*.ts",
  ".grasp/*.ts",
];

/**
 * A tsconfig for one kind of code: the compiler's options for it
 * (type-check.ts, as a tsconfig writes them), the files it checks, and
 * under `grasp` what the project's check holds them to besides: their
 * kind, and the modules they may resolve by name (`TypeTarget.allowed`).
 */
const kindConfig = (
  kind: string,
  target: TypeTarget,
  files: { include: string[]; exclude?: string[] }
) => ({
  compilerOptions: tsconfigOptions(target.options),
  ...files,
  grasp: {
    kind,
    ...(target.allowed === undefined
      ? {}
      : { allowed: [...target.allowed].toSorted() }),
  },
});

/**
 * The project's tsconfigs, one a kind of code, each as the platform checks
 * it, and the root tsconfig.json that lists them (an editor's, and the
 * check's): the App's screens with the DOM and JSX; its server code and
 * workflows with a worker's lib and no DOM; and each workflow version's
 * compute modules likewise, and the module the host generated from it.
 */
const planTypeCheck = (project: Plan): void => {
  const configs: Record<string, ReturnType<typeof kindConfig>> = {
    "app/tsconfig.screens.json": kindConfig(
      "screens",
      // Screens resolve whatever the kit holds: the kit's list is the
      // compiler's build output, not a module this can read.
      { options: compilerOptions, mapped: new Set() },
      {
        include: [
          "screens/*.tsx",
          "components/**/*.ts",
          "components/**/*.tsx",
          "*.d.ts",
          screenReferences.path,
        ],
      }
    ),
    "app/tsconfig.server.json": kindConfig("server", appCodeTarget, {
      include: [...serverCodeIncludes, "tests/**/*.ts"],
      exclude: ["**/*.d.ts"],
    }),
    "app/tsconfig.workflows.json": kindConfig("workflows", workflowTarget, {
      include: ["workflows/**/*.ts", ...serverCodeIncludes],
      exclude: ["**/*.d.ts"],
    }),
  };
  const versions = new Set(
    [...project.files.keys()].flatMap((file) => {
      const version = /^(?<base>workflows\/[^/]+\/[^/]+)\//u.exec(file)?.groups
        ?.base;
      return version === undefined ? [] : [version];
    })
  );
  for (const base of versions) {
    if (
      [...project.files.keys()].some((file) => file.startsWith(`${base}/code/`))
    ) {
      configs[`${base}/tsconfig.json`] = kindConfig("compute", computeTarget, {
        include: ["code/**/*.ts"],
        exclude: ["**/*.d.ts"],
      });
    }
    if (project.files.has(`${base}/.grasp/workflow.ts`)) {
      configs[`${base}/tsconfig.generated.json`] = kindConfig(
        "generated",
        generatedTarget,
        { include: [".grasp/workflow.ts"] }
      );
    }
  }
  for (const [file, config] of Object.entries(configs)) {
    project.add(file, jsonText(config));
  }
  project.add(
    "tsconfig.json",
    jsonText({
      files: [],
      references: Object.keys(configs).map((file) => ({ path: `./${file}` })),
    })
  );
};

/** A licence as an SPDX expression may be written: anything else is unknown. */
const spdxLike =
  /^[A-Za-z0-9][A-Za-z0-9.+-]*(?: (?:AND|OR|WITH) \(?[A-Za-z0-9][A-Za-z0-9.+-]*\)?)*$/u;

/** `licence` as the notices print it: SPDX-like, or "unknown". */
const licenceText = (licence: string | null): string =>
  licence !== null && licence.length <= 128 && spdxLike.test(licence)
    ? licence
    : "unknown";

/** The notices of `notices`, each package and version once, by name. */
const noticesText = (notices: readonly Notice[]): string => {
  const unique = new Map<string, Notice>();
  for (const notice of notices) {
    unique.set(
      `${notice.name}@${notice.version}`,
      unique.get(`${notice.name}@${notice.version}`) ?? notice
    );
  }
  const rows = [...unique.values()]
    .toSorted((a, b) => (a.name < b.name ? -1 : 1))
    .map(
      ({ name, version, licence, from }) =>
        `| ${name} | ${version} | ${licenceText(licence)} | ${from} |`
    );
  return [
    "# Third-party notices",
    "",
    "The packages under `vendor/@grasp-os/` are Grasp OS, licensed AGPL-3.0-only (`LICENSES/AGPL-3.0-only.txt`).",
    "",
    "Each package this project depends on directly, with the licence it declares. Their own dependencies carry their own notices.",
    "",
    "| Package | Version | Licence | Required by |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
};

/** The project's files for `input`, planned and checked; nothing written. */
export const planProject = async (
  input: PackagingInput
): Promise<Map<string, string>> => {
  const definition = readDefinition(input.definition);
  const project = newPlan();
  await planApp(project, definition.app);
  planWorkflows(project, definition.workflows);

  const notices: Notice[] = [];
  const pins = mergedPins([
    { owner: "the App", pins: appDependencies(definition.app.files, notices) },
    ...workflowDependencies(definition.workflows, notices),
  ]);
  const catalogText = readFileSync(
    path.join(input.repo, "pnpm-workspace.yaml"),
    "utf-8"
  );
  const catalog = readCatalog(catalogText);
  const vendoring: Vendoring = {
    repo: input.repo,
    catalog,
    version: `0.0.0-grasp.${input.commit.slice(0, 12)}`,
    notices,
  };
  for (const name of vendored) {
    planVendored(project, name, vendoring);
  }
  const typescriptVersion = platformTypescript(input.repo, catalogText);
  for (const name of [...projectDependencies, ...projectDevDependencies]) {
    notices.push({
      name,
      version:
        name === "typescript" ? typescriptVersion : pinned(catalog, name),
      licence: installedLicence(input.repo, "sdk", name),
      from: "the project",
    });
  }
  const pinnedAll = (names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, pinned(catalog, name)]));
  project.add(
    "package.json",
    jsonText({
      name: "grasp-app",
      version: `${definition.app.version}.0.0`,
      private: true,
      type: "module",
      // Its check runs as TypeScript, which Node strips without a flag
      // from 22.18.
      engines: { node: ">=22.18" },
      scripts: {
        typecheck: "node grasp/check.ts",
        build: "node grasp/check.ts",
      },
      dependencies: {
        ...Object.fromEntries(
          vendored.map((name) => [
            `@grasp-os/${name}`,
            `file:./vendor/@grasp-os/${name}`,
          ])
        ),
        ...pins.direct,
        ...pinnedAll(projectDependencies),
      },
      devDependencies: {
        ...pinnedAll(projectDevDependencies),
        typescript: typescriptVersion,
      },
      ...(Object.keys(pins.overrides).length === 0
        ? {}
        : { overrides: pins.overrides }),
    })
  );
  planTypeCheck(project);
  for (const [file, source] of Object.entries(checkFiles)) {
    project.add(
      file,
      readFileSync(path.join(input.repo, compilerSource, source), "utf-8")
    );
  }
  project.add(
    "grasp-project.json",
    jsonText({
      app: {
        version: definition.app.version,
        provenance: definition.app.provenance,
      },
      workflows: Object.fromEntries(
        Object.entries(definition.workflows).map(([key, workflow]) => [
          key,
          {
            provenance: workflow.provenance,
            withheldDefaults: workflow.withheldDefaults,
            withheldConstraints: workflow.withheldConstraints,
            packages:
              workflow.packages === null
                ? null
                : {
                    graphHash: workflow.packages.graphHash,
                    entries: workflow.packages.entries,
                  },
          },
        ])
      ),
      unresolved: definition.unresolved,
      vendor: { commit: input.commit, version: vendoring.version },
    })
  );
  project.add(
    "LICENSES/AGPL-3.0-only.txt",
    readFileSync(path.join(input.repo, "LICENSE"), "utf-8")
  );
  project.add("THIRD-PARTY-NOTICES.md", noticesText(notices));
  return project.files;
};

/** Refuses `out` unless it is missing or an empty directory, never a link. */
const requireFreshOut = (out: string): void => {
  let stat;
  try {
    stat = lstatSync(out);
  } catch {
    return;
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    readdirSync(out).length > 0
  ) {
    refuse("--out must be a new or empty directory.");
  }
};

/**
 * Writes the project for `input` into `input.out`, once all of it is
 * planned and checked: built in a new directory beside it, then renamed
 * onto it (missing, or empty), so `--out` holds all of it or none.
 * Answers the paths written, sorted.
 */
export const packageProject = async (
  input: PackagingInput
): Promise<string[]> => {
  const out = path.resolve(input.out);
  requireFreshOut(out);
  const files = await planProject(input);
  mkdirSync(path.dirname(out), { recursive: true });
  const building = mkdtempSync(path.join(path.dirname(out), ".grasp-project-"));
  try {
    for (const [file, text] of files) {
      const target = path.resolve(building, file);
      if (!target.startsWith(`${building}${path.sep}`)) {
        refuse(`${file}: lands outside the project.`);
      }
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text, { flag: "wx" });
    }
    // Checked again just before, and an empty `--out` removed first: not
    // every platform renames onto a directory, and removing one refuses
    // unless it is empty.
    requireFreshOut(out);
    if (existsSync(out)) {
      rmdirSync(out);
    }
    renameSync(building, out);
  } catch (error) {
    rmSync(building, { recursive: true, force: true });
    throw error;
  }
  return [...files.keys()].toSorted();
};
