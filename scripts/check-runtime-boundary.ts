/**
 * Holds the runtime's import boundaries (GRA-1374), so a change that
 * breaks one fails CI rather than a review:
 *
 * - From `@grasp-os/runtime/connector`, the one entry of the runtime connect
 *   and every connector reach, and from each connector package's entry,
 *   nothing reaches the runtime's App or workflow code, React, TanStack or
 *   the design system's packages.
 * - Each of the runtime's folders imports only its own files and common's.
 *
 * It walks the imports a module runs, read with oxc's parser: static
 * imports, re-exports and `import()`. Type-only ones don't count:
 * compiling erases them. Workspace packages resolve through their
 * package.json `exports` and `imports`, under every condition at once.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { parseSync } from "oxc-parser";
import { z } from "zod";

/**
 * The runtime's folders (packages/runtime/src): one per kind of code, and
 * `common`, what more than one kind uses. A file imports by value only
 * its own folder's files and common's; common imports none of the others.
 */
const commonFolder = "common";

/** The runtime's folders connector code never reaches. */
const notForConnectors = new Set(["app", "workflow"]);

/** Packages connector code never reaches: React, TanStack and the design system's. */
const forbiddenPackage =
  /^(?:react|react-dom)(?:\/|$)|^@tanstack\/|^@grasp-os\/(?:app-kit|ui)(?:\/|$)/u;

/** The one entry of the runtime connect imports. */
const connectorEntry = "@grasp-os/runtime/connector";

/**
 * An `import()` of a computed value: no walk can follow it, so it is a
 * violation wherever the walk reaches one.
 */
const computedImport = "import() of a computed value";

/** The folders that hold workspace packages, one package per child folder. */
const packageFolders = ["packages", "packages/connectors", "apps"];

const sourceFile = /\.[cm]?[jt]sx?$/u;

const declarationFile = /\.d\.[cm]?ts$/u;

const javaScriptExtension = /\.(?<module>[cm]?)js$/u;

/** A string literal with no placeholder: an `import()` that names its module. */
const stringLiteral = /^(?<quote>["'`])(?<value>[^"'`$]*)\k<quote>$/u;

/** What a relative import may leave off, tried after the name as written. */
const suffixes = [".ts", ".tsx", ".js", "/index.ts", "/index.tsx", "/index.js"];

export interface Violation {
  rule: "connector-entry" | "connector-package" | "runtime-folders";
  /** What reaches it: repo-relative files from the entry, then the module. */
  chain: string[];
}

const manifestSchema = z.object({
  name: z.string().optional(),
  exports: z.unknown().optional(),
  imports: z.unknown().optional(),
});

interface WorkspacePackage {
  name: string;
  dir: string;
  exports: unknown;
  imports: unknown;
}

/** A module the walk reached: a file, or a package it doesn't follow. */
type Reached = { file: string } | { external: string };

interface Walked {
  reached: Reached;
  chain: string[];
}

const isFile = (file: string): boolean =>
  existsSync(file) && statSync(file).isFile();

const isRelative = (specifier: string): boolean =>
  specifier.startsWith("./") || specifier.startsWith("../");

const manifestOf = (file: string): z.infer<typeof manifestSchema> =>
  manifestSchema.parse(JSON.parse(readFileSync(file, "utf-8")));

const workspacePackages = (root: string): WorkspacePackage[] =>
  packageFolders.flatMap((folder) => {
    const parent = path.join(root, folder);
    return (existsSync(parent) ? readdirSync(parent) : []).flatMap((each) => {
      const dir = path.join(parent, each);
      const file = path.join(dir, "package.json");
      if (!isFile(file)) {
        return [];
      }
      const { name, exports, imports } = manifestOf(file);
      return name === undefined ? [] : [{ name, dir, exports, imports }];
    });
  });

/** Every path a package.json target names, under every condition. */
const targetsOf = (target: unknown): string[] => {
  if (typeof target === "string") {
    return [target];
  }
  if (typeof target === "object" && target !== null) {
    return Object.values(target).flatMap(targetsOf);
  }
  return [];
};

/** The targets an `exports` or `imports` field gives `key`, by its patterns too. */
const lookUp = (field: unknown, key: string): string[] => {
  if (typeof field === "string" || Array.isArray(field)) {
    return key === "." ? targetsOf(field) : [];
  }
  if (typeof field !== "object" || field === null) {
    return [];
  }
  const entries = Object.entries(field);
  const exact = entries.find(([each]) => each === key);
  if (exact !== undefined) {
    return targetsOf(exact[1]);
  }
  for (const [pattern, target] of entries) {
    const [before = "", after, ...more] = pattern.split("*");
    if (
      after !== undefined &&
      more.length === 0 &&
      key.length >= before.length + after.length &&
      key.startsWith(before) &&
      key.endsWith(after)
    ) {
      const matched = key.slice(before.length, key.length - after.length);
      return targetsOf(target).map((each) => each.replaceAll("*", matched));
    }
  }
  return [];
};

/** The file a relative `specifier` names from `file`, if there is one. */
const resolveRelative = (
  file: string,
  specifier: string
): string | undefined => {
  const base = path.resolve(path.dirname(file), specifier);
  return [
    base,
    base.replace(javaScriptExtension, ".$<module>ts"),
    ...suffixes.map((suffix) => base + suffix),
  ].find(isFile);
};

/**
 * The modules `file` imports when it runs, as written: type-only imports
 * and re-exports left out, and `computedImport` for an `import()` of
 * anything but a string.
 */
export const importsOf = (file: string): string[] => {
  const source = readFileSync(file, "utf-8");
  const { module, errors } = parseSync(file, source);
  const [error] = errors;
  if (error !== undefined) {
    throw new Error(`${file} doesn't parse: ${error.message}`);
  }
  const imports = module.staticImports
    .filter(
      ({ entries }) =>
        entries.length === 0 || entries.some(({ isType }) => !isType)
    )
    .map(({ moduleRequest }) => moduleRequest.value);
  const exports = module.staticExports.flatMap(({ entries }) =>
    entries.flatMap(({ moduleRequest, isType }) =>
      moduleRequest === null || isType ? [] : [moduleRequest.value]
    )
  );
  const dynamic = module.dynamicImports.map(
    ({ moduleRequest }) =>
      stringLiteral.exec(
        source.slice(moduleRequest.start, moduleRequest.end).trim()
      )?.groups?.value ?? computedImport
  );
  return [...new Set([...imports, ...exports, ...dynamic])];
};

/** Every source file under `dir`, but what installs and builds write. */
const sourcesUnder = (dir: string): string[] =>
  (existsSync(dir)
    ? readdirSync(dir, { recursive: true, encoding: "utf-8" })
    : []
  )
    .filter(
      (each) =>
        sourceFile.test(each) &&
        !each
          .split(path.sep)
          .some((part) => part === "node_modules" || part === "dist")
    )
    .map((each) => path.join(dir, each));

/** Every import across the runtime's boundaries in the workspace at `root`. */
export const runtimeBoundaryViolations = (root: string): Violation[] => {
  const packages = workspacePackages(root);
  const longest = (
    matches: (each: WorkspacePackage) => boolean
  ): WorkspacePackage | undefined => {
    const [found] = packages
      .filter(matches)
      .toSorted((a, b) => b.dir.length - a.dir.length);
    return found;
  };
  const ownerOf = (file: string): WorkspacePackage | undefined =>
    longest(({ dir }) => file.startsWith(`${dir}${path.sep}`));
  const label = (reached: Reached): string =>
    "file" in reached ? path.relative(root, reached.file) : reached.external;

  /** What `specifier`, imported by `file`, reaches. */
  const resolve = (file: string, specifier: string): Reached[] => {
    if (isRelative(specifier)) {
      const resolved = resolveRelative(file, specifier);
      if (resolved === undefined) {
        throw new Error(
          `${label({ file })} imports "${specifier}", which isn't there`
        );
      }
      return [{ file: resolved }];
    }
    if (specifier.startsWith("#")) {
      const owner = ownerOf(file);
      return lookUp(owner?.imports, specifier).flatMap((target) =>
        isRelative(target)
          ? [path.resolve(owner?.dir ?? root, target)]
              .filter(isFile)
              .map((each) => ({ file: each }))
          : resolve(file, target)
      );
    }
    const workspace = longest(
      ({ name }) => specifier === name || specifier.startsWith(`${name}/`)
    );
    // A forbidden package isn't followed: reaching it is the violation.
    if (workspace === undefined || forbiddenPackage.test(specifier)) {
      return [{ external: specifier }];
    }
    const targets = lookUp(
      workspace.exports,
      `.${specifier.slice(workspace.name.length)}`
    );
    if (targets.length === 0) {
      throw new Error(
        `${label({ file })} imports "${specifier}", which isn't exported`
      );
    }
    return targets
      .map((target) => path.resolve(workspace.dir, target))
      .filter(isFile)
      .map((each) => ({ file: each }));
  };

  /**
   * Every module `entry` reaches, with the chain that reaches it. The
   * walk stops at a module `stop` holds, so each violation is reported
   * where it starts.
   */
  const reach = (
    entry: string,
    stop: (reached: Reached) => boolean
  ): Walked[] => {
    const first: Reached = { file: entry };
    const seen = new Map<string, Walked>([
      [label(first), { reached: first, chain: [label(first)] }],
    ]);
    const queue: Walked[] = [...seen.values()];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const { reached, chain } = next;
      if (
        "file" in reached &&
        !stop(reached) &&
        sourceFile.test(reached.file) &&
        !declarationFile.test(reached.file)
      ) {
        for (const specifier of importsOf(reached.file)) {
          const found =
            specifier === computedImport
              ? [{ external: `${computedImport} in ${label(reached)}` }]
              : resolve(reached.file, specifier);
          for (const each of found.filter((one) => !seen.has(label(one)))) {
            const walked = { reached: each, chain: [...chain, label(each)] };
            seen.set(label(each), walked);
            queue.push(walked);
          }
        }
      }
    }
    return [...seen.values()];
  };

  const runtime = packages.find(({ name }) => name === "@grasp-os/runtime");
  if (runtime === undefined) {
    throw new Error("The workspace has no @grasp-os/runtime");
  }
  const entryOf = (key: string): string => {
    const [target] = lookUp(runtime.exports, key);
    if (target === undefined) {
      throw new Error(`@grasp-os/runtime exports no "${key}"`);
    }
    return path.resolve(runtime.dir, target);
  };
  const runtimeSource = path.join(runtime.dir, "src");
  /** The runtime folder `file` is in, if it is one of the runtime's sources. */
  const folderOf = (file: string): string | undefined =>
    file.startsWith(`${runtimeSource}${path.sep}`)
      ? path.relative(runtimeSource, file).split(path.sep)[0]
      : undefined;
  const forbids = (reached: Reached): boolean =>
    "file" in reached
      ? notForConnectors.has(folderOf(reached.file) ?? "") ||
        forbiddenPackage.test(ownerOf(reached.file)?.name ?? "")
      : forbiddenPackage.test(reached.external) ||
        reached.external.startsWith(computedImport);

  const fromEntry = reach(entryOf("./connector"), forbids)
    .filter(({ reached }) => forbids(reached))
    .map(({ chain }): Violation => ({ rule: "connector-entry", chain }));

  const connectors = path.join(root, "packages/connectors");
  const fromConnectors = (existsSync(connectors) ? readdirSync(connectors) : [])
    .map((each) => path.join(connectors, each, "package.json"))
    .filter(isFile)
    .flatMap((file) =>
      lookUp(manifestOf(file).exports, ".").map((entry) =>
        path.resolve(path.dirname(file), entry)
      )
    )
    .flatMap((entry) =>
      reach(entry, forbids)
        .filter(({ reached }) => forbids(reached))
        .map(({ chain }): Violation => ({ rule: "connector-package", chain }))
    );

  const fromFolders = sourcesUnder(runtimeSource)
    .filter((file) => !declarationFile.test(file))
    .flatMap((file) =>
      importsOf(file)
        .filter((specifier) => specifier !== computedImport)
        .flatMap((specifier) => resolve(file, specifier))
        .flatMap((reached) => {
          const folder = "file" in reached ? folderOf(reached.file) : undefined;
          return folder === undefined ||
            folder === commonFolder ||
            folder === folderOf(file)
            ? []
            : [
                {
                  rule: "runtime-folders" as const,
                  chain: [label({ file }), label(reached)],
                },
              ];
        })
    );

  return [...fromEntry, ...fromConnectors, ...fromFolders];
};

/** What each rule holds, for the report. */
const rules: Record<Violation["rule"], string> = {
  "connector-entry": `${connectorEntry} reaches no App or workflow code, React, TanStack or design system`,
  "connector-package":
    "A connector reaches no App or workflow code, React, TanStack or design system",
  "runtime-folders":
    "A runtime folder imports only its own files and common's, and common none of the others'",
};

if (import.meta.main) {
  const violations = runtimeBoundaryViolations(
    path.join(import.meta.dirname, "..")
  );
  for (const { rule, chain } of violations) {
    console.error(`${rules[rule]}:\n  ${chain.join("\n  → ")}`);
  }
  if (violations.length > 0) {
    process.exit(1);
  }
}
