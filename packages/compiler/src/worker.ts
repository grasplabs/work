/**
 * The screen compiler, as it runs in its own isolate (a Dynamic Worker, one
 * per build). It has no bindings and no network: it reads the files it is
 * given and what it knows of the kit, nothing else.
 *
 * Each App file becomes one ES module: Babel runs the React Compiler,
 * strips types and turns JSX into calls, then points imports at flat module
 * names (see kit.ts). There is no bundler: the kit's modules are built once
 * per release and shared by every App, and a build says which of them, and
 * which of the App's own, each screen loads. Once every file compiles, the
 * App is type-checked and linted against the kit's design system; then
 * Tailwind compiles the CSS for the classes in the App's sources and in the
 * kit modules it loads.
 *
 * It also builds an App's server code and workflows, which run in core
 * (see `buildServer` and `buildWorkflows`): the same Babel, stripping
 * types only.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { compile } from "tailwindcss";

import kit from "#kit";

import { extractCandidates } from "./candidates.ts";
import { compileModule, stripTypes, transformModule } from "./compile.ts";
import { isError } from "./diagnostic.ts";
import type { Diagnostic } from "./diagnostic.ts";
import {
  collectImports,
  importError,
  codeImportError,
  rewriteCodeImports,
  rewriteImports,
  serverCode,
  workflowCode,
} from "./imports.ts";
import type { CodeKind, ImportSite, ModuleImports } from "./imports.ts";
import {
  buildFiles,
  declarationFile,
  limitErrors,
  screenFile,
  serverEntry,
  serverFiles,
  workflowFiles,
} from "./inputs.ts";
import {
  appModuleName,
  kitModuleName,
  kitStylesheet,
  ownEntry,
  screenRuntime,
} from "./kit.ts";
import { lint } from "./lint.ts";
import { typeCheck } from "./type-check.ts";

/**
 * What a page loads to run one screen, by flat name: of the App's modules,
 * the screen's and what it imports, directly or through others; of the
 * kit's, what those import, and the screen runtime.
 */
export interface ScreenClosure {
  modules: string[];
  kitModules: string[];
}

/**
 * An App's modules by flat name, the kit's modules a page needs to run them
 * (what they import, directly or through each other, and the screen
 * runtime), what each screen loads of both, by its module's name, and the
 * CSS they use; or why it failed. Errors fail a build; warnings don't.
 */
export type ScreenBuild =
  | {
      ok: true;
      modules: Record<string, string>;
      kitModules: string[];
      screens: Record<string, ScreenClosure>;
      css: string;
      diagnostics: Diagnostic[];
    }
  | { ok: false; diagnostics: Diagnostic[] };

/** The line a React Compiler error points at in its code frame: `> 3 |`. */
const framedLine = /^> *(?<line>\d+) \|/mu;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface Location {
  file?: string;
  line?: number;
  column?: number;
}

/** Where Babel says an error is: its syntax errors carry `loc`, columns from 0. */
const locationOf = (error: unknown): Location => {
  if (typeof error !== "object" || error === null || !("loc" in error)) {
    return {};
  }
  const { loc } = error;
  if (
    typeof loc !== "object" ||
    loc === null ||
    !("line" in loc) ||
    !("column" in loc)
  ) {
    return {};
  }
  const { line, column } = loc;
  return typeof line === "number" && typeof column === "number"
    ? { line, column: column + 1 }
    : {};
};

/** Where a compile error is: Babel's location, or the React Compiler's line. */
const compileErrorAt = (error: unknown, message: string): Location => {
  const located = locationOf(error);
  const line = framedLine.exec(message)?.groups?.line;
  return located.line === undefined && line !== undefined
    ? { line: Number(line) }
    : located;
};

/** A compile error's message, in words for whoever fixes the file. */
const compileMessage = (message: string): string =>
  message.includes("Handle Import expressions")
    ? "import() can't be used inside a component or hook: import the module at the top of the file."
    : message;

/** An error, which fails the build. */
const problem = (
  rule: string,
  message: string,
  at: Location = {}
): Diagnostic => ({ ...at, rule, severity: "error", message });

/** Two App files that would share a module name, e.g. `a.ts` and `a.tsx`. */
const nameClashes = (paths: string[]): Diagnostic[] => {
  const byName = new Map<string, string>();
  const clashes: Diagnostic[] = [];
  for (const path of paths) {
    const other = byName.get(appModuleName(path));
    if (other === undefined) {
      byName.set(appModuleName(path), path);
    } else {
      clashes.push(
        problem("file-names", `Rename it or ${other}; they can't both exist.`, {
          file: path,
        })
      );
    }
  }
  return clashes;
};

/**
 * An error's message without the file Babel names in it (as `/<path>`):
 * the diagnostic names it on its own.
 */
const messageIn = (path: string, error: unknown): string =>
  messageOf(error).replace(`/${path}: `, "").replace(`${path}: `, "");

/** Compiles one App file, with what it imports, or says why it can't be. */
const compileFile = (
  path: string,
  source: string,
  files: ReadonlySet<string>
): { code: string; imported: ModuleImports } | { errors: Diagnostic[] } => {
  const imports: ImportSite[] = [];
  let compiled: string;
  try {
    compiled = compileModule(source, path, [collectImports(imports)]);
  } catch (error) {
    const message = messageIn(path, error);
    return {
      errors: [
        problem("compile", compileMessage(message), {
          file: path,
          ...compileErrorAt(error, message),
        }),
      ],
    };
  }
  const errors: Diagnostic[] = [];
  for (const site of imports) {
    const message = importError(site, path, files, kit);
    if (message !== undefined) {
      errors.push(
        problem(
          "imports",
          message,
          site.line === undefined
            ? { file: path }
            : { file: path, line: site.line }
        )
      );
    }
  }
  if (errors.length > 0) {
    return { errors };
  }
  const imported: ModuleImports = { app: new Set(), kit: new Set() };
  try {
    return {
      code: transformModule(compiled, path, [
        rewriteImports(path, files, kit, imported),
      ]),
      imported,
    };
  } catch (error) {
    return {
      errors: [problem("imports", messageIn(path, error), { file: path })],
    };
  }
};

/** These modules and every module they import, through `importsOf`. */
const closureOf = (
  roots: Iterable<string>,
  importsOf: (name: string) => Iterable<string>
): string[] => {
  const needed = new Set<string>();
  const queue = [...roots];
  for (const name of queue) {
    if (!needed.has(name)) {
      needed.add(name);
      queue.push(...importsOf(name));
    }
  }
  return [...needed].toSorted();
};

/**
 * The kit's modules these import, and every kit module those import. The
 * runtime renders the screens: a page needs it for any of them.
 */
const kitModulesFor = (imported: Iterable<string>): string[] =>
  closureOf(
    [...imported, kitModuleName(screenRuntime)],
    (name) => ownEntry(kit.moduleImports, name) ?? []
  );

/**
 * What a page loads for the screen in the module `entry`, given what each
 * of the App's modules imports: not the App's other screens, nor what only
 * they use of the kit.
 */
const screenClosure = (
  entry: string,
  imports: ReadonlyMap<string, ModuleImports>
): ScreenClosure => {
  const modules = closureOf([entry], (name) => imports.get(name)?.app ?? []);
  return {
    modules,
    kitModules: kitModulesFor(
      modules.flatMap((name) => [...(imports.get(name)?.kit ?? [])])
    ),
  };
};

/**
 * The CSS for the kit's theme and every class used by the App and by the
 * kit modules it loads (`kitModules`).
 */
const buildCss = async (
  sources: string[],
  kitModules: string[]
): Promise<string> => {
  const tailwind = await compile(kit.stylesheets[kitStylesheet] ?? "", {
    // The kit's stylesheet only imports stylesheets that ship with the kit.
    // oxlint-disable-next-line require-await -- Tailwind expects a promise
    loadStylesheet: async (id: string) => {
      const content = ownEntry(kit.stylesheets, id);
      if (content === undefined) {
        throw new Error(`The stylesheet "${id}" is not in the kit`);
      }
      return { path: id, base: "/", content };
    },
  });
  return tailwind.build([
    ...kitModules.flatMap((name) => ownEntry(kit.moduleCandidates, name) ?? []),
    ...sources.flatMap((source) => extractCandidates(source)),
  ]);
};

/**
 * Type-checks the App against the kit's types and lints it against the
 * kit's design system.
 */
export const checkScreens = (files: Record<string, string>): Diagnostic[] => {
  const app = buildFiles(files);
  const tooMuch = limitErrors(app);
  if (tooMuch.length > 0) {
    return tooMuch;
  }
  return [...typeCheck(app, kit.types), ...lint(app, kit)];
};

/**
 * Builds an App's screens: `screens/*.tsx`, the `components/` they use and
 * the declarations (`*.d.ts`) at the App's root.
 */
export const buildScreens = async (
  files: Record<string, string>
): Promise<ScreenBuild> => {
  const app = buildFiles(files);
  const tooMuch = limitErrors(app);
  if (tooMuch.length > 0) {
    return { ok: false, diagnostics: tooMuch };
  }
  const sources = Object.entries(app).filter(
    ([path]) => !declarationFile.test(path)
  );
  const paths = sources.map(([path]) => path);
  if (!paths.some((path) => screenFile.test(path))) {
    return {
      ok: false,
      diagnostics: [
        problem(
          "screens",
          "The App has no screens: add one as screens/<name>.tsx."
        ),
      ],
    };
  }
  const clashes = nameClashes(paths);
  if (clashes.length > 0) {
    return { ok: false, diagnostics: clashes };
  }
  const known = new Set(paths);
  const modules: Record<string, string> = {};
  const imports = new Map<string, ModuleImports>();
  const errors: Diagnostic[] = [];
  for (const [path, source] of sources) {
    const result = compileFile(path, source, known);
    if ("code" in result) {
      modules[appModuleName(path)] = result.code;
      imports.set(appModuleName(path), result.imported);
    } else {
      errors.push(...result.errors);
    }
  }
  // The checks would only say it again, less clearly.
  if (errors.length > 0) {
    return { ok: false, diagnostics: errors };
  }
  const diagnostics = checkScreens(files);
  if (diagnostics.some((diagnostic) => isError(diagnostic))) {
    return { ok: false, diagnostics };
  }
  const kitModules = kitModulesFor(
    [...imports.values()].flatMap(({ kit: imported }) => [...imported])
  );
  const css = await buildCss(
    sources.map(([, source]) => source),
    kitModules
  );
  return {
    ok: true,
    modules,
    kitModules,
    screens: Object.fromEntries(
      paths
        .filter((path) => screenFile.test(path))
        .map((path) => appModuleName(path))
        .map((entry) => [entry, screenClosure(entry, imports)])
    ),
    css,
    diagnostics,
  };
};

/**
 * An App's server code as modules by flat name, and the one that exports
 * its `App` class; or why it failed.
 */
export type ServerBuild =
  | { ok: true; mainModule: string; modules: Record<string, string> }
  | { ok: false; diagnostics: Diagnostic[] };

/** Compiles one server or workflow file, or says why it can't be. */
const compileCodeFile = (
  kind: CodeKind,
  path: string,
  source: string,
  files: ReadonlySet<string>
): { code: string } | { errors: Diagnostic[] } => {
  const imports: ImportSite[] = [];
  let compiled: string;
  try {
    compiled = stripTypes(source, path, [collectImports(imports)]);
  } catch (error) {
    const message = messageIn(path, error);
    return {
      errors: [
        problem("compile", message, { file: path, ...locationOf(error) }),
      ],
    };
  }
  const errors = imports.flatMap(({ specifier, line }) => {
    const message = codeImportError(kind, specifier, path, files);
    return message === undefined
      ? []
      : [
          problem(
            "imports",
            message,
            line === undefined ? { file: path } : { file: path, line }
          ),
        ];
  });
  if (errors.length > 0) {
    return { errors };
  }
  try {
    return {
      code: transformModule(compiled, path, [
        rewriteCodeImports(kind, path, files),
      ]),
    };
  } catch (error) {
    return {
      errors: [problem("imports", messageIn(path, error), { file: path })],
    };
  }
};

/**
 * An App's workflows (`workflows/**.ts`, their tests included) as modules
 * by flat name; or why they failed. They import the SDK's modules, which
 * core loads next to them.
 */
export type WorkflowBuild =
  | { ok: true; modules: Record<string, string> }
  | { ok: false; diagnostics: Diagnostic[] };

/** App code compiled file by file, as modules by flat name. */
const compileCode = (
  kind: CodeKind,
  files: Record<string, string>
): WorkflowBuild => {
  const known = new Set(Object.keys(files));
  const modules: Record<string, string> = {};
  const errors: Diagnostic[] = [];
  for (const [path, source] of Object.entries(files)) {
    const result = compileCodeFile(kind, path, source, known);
    if ("code" in result) {
      modules[appModuleName(path)] = result.code;
    } else {
      errors.push(...result.errors);
    }
  }
  return errors.length > 0
    ? { ok: false, diagnostics: errors }
    : { ok: true, modules };
};

/**
 * Builds an App's server: `app/server.ts`, which exports its `App` class,
 * and the other TypeScript files under `app/`. Types are stripped, not
 * checked; imports reach only those files and the Workers runtime.
 */
export const buildServer = (files: Record<string, string>): ServerBuild => {
  const server = serverFiles(files);
  const tooMuch = limitErrors(server);
  if (tooMuch.length > 0) {
    return { ok: false, diagnostics: tooMuch };
  }
  if (!Object.hasOwn(server, serverEntry)) {
    return {
      ok: false,
      diagnostics: [
        problem(
          "server",
          `The App has no server: add ${serverEntry}, exporting its App class.`
        ),
      ],
    };
  }
  const built = compileCode(serverCode, server);
  return built.ok
    ? { ...built, mainModule: appModuleName(serverEntry) }
    : built;
};

/**
 * Builds an App's workflows: the TypeScript files under `workflows/`.
 * Types are stripped, not checked; imports reach only those files and the
 * SDK.
 */
export const buildWorkflows = (
  files: Record<string, string>
): WorkflowBuild => {
  const workflows = workflowFiles(files);
  const tooMuch = limitErrors(workflows);
  return tooMuch.length > 0
    ? { ok: false, diagnostics: tooMuch }
    : compileCode(workflowCode, workflows);
};

export default class ScreenCompiler extends WorkerEntrypoint {
  // RPC exposes prototype methods only, so these can't be static.
  // oxlint-disable-next-line class-methods-use-this
  async build(files: Record<string, string>): Promise<ScreenBuild> {
    return await buildScreens(files);
  }

  /** Builds the App's server code (`buildServer`). */
  // oxlint-disable-next-line class-methods-use-this
  buildServer(files: Record<string, string>): ServerBuild {
    return buildServer(files);
  }

  /** Builds the App's workflows (`buildWorkflows`). */
  // oxlint-disable-next-line class-methods-use-this
  buildWorkflows(files: Record<string, string>): WorkflowBuild {
    return buildWorkflows(files);
  }

  /** Only the type check and the lint, without building. */
  // oxlint-disable-next-line class-methods-use-this
  check(files: Record<string, string>): Diagnostic[] {
    return checkScreens(files);
  }
}
