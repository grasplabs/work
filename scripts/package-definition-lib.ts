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
 * - A package's file path writes outside where it belongs: every path is
 *   checked before anything is written (`safePath`): relative, `/`
 *   separated, no empty, `.` or `..` segment, no backslash, drive or NUL,
 *   and each lands inside its own subtree once resolved. Two paths that
 *   differ only by case are refused, as is an App file where the
 *   references are generated. The whole project is planned first, and
 *   nothing is written unless all of it checks.
 * - It writes through something already there: `--out` must not exist or
 *   be an empty directory, never a link, and every file is created anew
 *   (`wx`) in directories this made.
 * - The package isn't one the platform made, or for another SDK protocol:
 *   it is parsed with the strict package schema, its registration with
 *   the SDK's strict reader, and a protocol other than the checkout's is
 *   refused.
 * - Packages are fetched that nothing pinned, or the network is reached:
 *   nothing here makes a network call. The project names exact versions
 *   only: the App's direct dependencies from its own lock, and the
 *   catalog's for what the vendored packages need. Installing is the
 *   developer's step, after.
 * - Code from the package runs: none does. The references are generated
 *   from the registration as data (`generateModules`).
 * - Licences: the vendored packages ship with their AGPL-3.0 text, and the
 *   notices list each direct dependency with the licence its lock or
 *   installed package declares, "unknown" where neither does.
 */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { generateModules, readAppManifest } from "@grasp-os/sdk/host";
import { sdkProtocolVersion } from "@grasp-os/shared/app-releases";
import { definitionPackageSchema } from "@grasp-os/shared/definition-packages";
import type { DefinitionPackage } from "@grasp-os/shared/definition-packages";
import { graspLockSchema } from "@grasp-os/shared/packages";
import { z } from "zod";

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

const segmentPattern = /^[^\\/:*?"<>|\0]+$/u;
const drivePattern = /^[A-Za-z]:/u;
const workflowKeyPattern =
  /^workspace\/(?<name>[a-z0-9-]+)\/(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u;

/**
 * `relative` as a path inside a project subtree: `/`-separated segments,
 * none empty, `.` or `..`, with no backslash, colon, drive or NUL, and at
 * most 512 characters. Refuses anything else, naming `where`.
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
    if (segment === "." || segment === ".." || !segmentPattern.test(segment)) {
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
  const folded = new Set<string>();
  return {
    files,
    add: (file, text) => {
      const key = file.toLowerCase();
      if (folded.has(key)) {
        refuse(
          `${file}: another file has this path, or one that differs only by case.`
        );
      }
      folded.add(key);
      files.set(file, text);
    },
  };
};

/** `value` as JSON text, as the project's files hold it. */
const jsonText = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

/** The exact versions `pnpm-workspace.yaml`'s `catalog:` pins, by name. */
export const readCatalog = (text: string): Map<string, string> => {
  const catalog = new Map<string, string>();
  let inCatalog = false;
  for (const line of text.split("\n")) {
    if (/^\S/u.test(line)) {
      inCatalog = line.trim() === "catalog:";
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
  const generated = await generateModules(readAppManifest(app.manifest), {
    resourceId: localIdentity,
    resourceVersion: app.version,
  });
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

/** The App's own dependencies, exactly as its lock resolved them. */
const appDependencies = (
  files: Readonly<Record<string, string>>,
  notices: Notice[]
): Record<string, string> => {
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
    return {};
  }
  const lock = graspLockSchema.safeParse(JSON.parse(lockText));
  if (!lock.success) {
    return refuse(
      "The App's grasp.lock.json isn't a lock this checkout reads."
    );
  }
  const locked = Object.values(lock.data.packages);
  for (const [name, version] of Object.entries(lock.data.direct)) {
    notices.push({
      name,
      version,
      licence:
        locked.find((entry) => entry.name === name && entry.version === version)
          ?.license ?? null,
      from: "the App's lock",
    });
  }
  return lock.data.direct;
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

/** The project's TypeScript configuration: the references by their names. */
const tsconfig = {
  compilerOptions: {
    target: "es2024",
    lib: ["es2024", "esnext.disposable", "dom", "dom.iterable"],
    module: "preserve",
    moduleResolution: "bundler",
    moduleDetection: "force",
    jsx: "react-jsx",
    resolveJsonModule: true,
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    isolatedModules: true,
    noEmit: true,
    strict: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    types: [],
    paths: {
      "#grasp": ["./app/.grasp/references.ts"],
      "#grasp/server": ["./app/.grasp/server.ts"],
      "#grasp/server-references": ["./app/.grasp/server-references.ts"],
    },
  },
  include: ["app", "workflows"],
};

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
        `| ${name} | ${version} | ${licence ?? "unknown"} | ${from} |`
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
  const dependencies = appDependencies(definition.app.files, notices);
  const catalog = readCatalog(
    readFileSync(path.join(input.repo, "pnpm-workspace.yaml"), "utf-8")
  );
  const vendoring: Vendoring = {
    repo: input.repo,
    catalog,
    version: `0.0.0-grasp.${input.commit.slice(0, 12)}`,
    notices,
  };
  for (const name of vendored) {
    planVendored(project, name, vendoring);
  }
  for (const name of [...projectDependencies, ...projectDevDependencies]) {
    notices.push({
      name,
      version: pinned(catalog, name),
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
      scripts: { typecheck: "tsc --noEmit -p .", build: "tsc --noEmit -p ." },
      dependencies: {
        ...Object.fromEntries(
          vendored.map((name) => [
            `@grasp-os/${name}`,
            `file:./vendor/@grasp-os/${name}`,
          ])
        ),
        ...pinnedAll(projectDependencies),
        ...dependencies,
      },
      devDependencies: pinnedAll(projectDevDependencies),
    })
  );
  project.add("tsconfig.json", jsonText(tsconfig));
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
 * planned and checked: answers the paths written, sorted.
 */
export const packageProject = async (
  input: PackagingInput
): Promise<string[]> => {
  requireFreshOut(input.out);
  const files = await planProject(input);
  const root = path.resolve(input.out);
  for (const file of files.keys()) {
    const target = path.resolve(root, file);
    if (!target.startsWith(`${root}${path.sep}`)) {
      refuse(`${file}: lands outside the project.`);
    }
  }
  mkdirSync(root, { recursive: true });
  for (const [file, text] of files) {
    const target = path.resolve(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, { flag: "wx" });
  }
  return [...files.keys()].toSorted();
};
