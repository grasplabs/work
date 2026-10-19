/**
 * The App compiler, as it runs in its own isolate (a Dynamic Worker, one
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
import { packageEntrySchema } from "@grasp-os/shared/packages";
import { WorkerEntrypoint } from "cloudflare:workers";
import { compile } from "tailwindcss";

import kit from "#kit";

import {
  appCodeFiles,
  appCodeImport,
  appCodeKind,
  appTestFiles,
  isAppLayout,
  isAppTestSuite,
  maxAppTestSuites,
  strayServerFileMessage,
  strayServerFiles,
  strayTestFileMessage,
  strayTestFiles,
  typeImportError,
  workflowTypeContext,
} from "./app-code.ts";
import { assertNoBindings } from "./authority.ts";
import { extractCandidates } from "./candidates.ts";
import { compileModule, stripTypes, transformModule } from "./compile.ts";
import { isError } from "./diagnostic.ts";
import type { Diagnostic } from "./diagnostic.ts";
import {
  collectDirectives,
  collectImports,
  declarationValueImportError,
  importError,
  codeImportError,
  rewriteAppCodeImports,
  rewriteCodeImports,
  computeCodeWith,
  generatedWorkflowCode,
  rewriteImports,
  screenTypeImportError,
  serverCode,
  workflowCode,
} from "./imports.ts";
import type {
  CodeKind,
  DirectiveSite,
  ImportSite,
  ModuleImports,
} from "./imports.ts";
import {
  appCodeLimitErrors,
  buildFiles,
  declarationFile,
  limitErrors,
  computeModuleErrors,
  openWorkflowErrors,
  screenFile,
  serverEntry,
  serverFiles,
  workflowFiles,
} from "./inputs.ts";
import {
  appModuleName,
  computePackagesFile,
  kitModuleName,
  kitStylesheet,
  ownEntry,
  screenReferences,
  screenRuntime,
} from "./kit.ts";
import { lint } from "./lint.ts";
import {
  appCodeTarget,
  computeTarget,
  screenTarget,
  typeCheck,
  workflowTarget,
} from "./type-check.ts";

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
 * An App's modules by flat name, what each screen loads of them and of the
 * kit's, by its module's name, and the CSS they use; or why it failed.
 * Errors fail a build; warnings don't.
 */
export type ScreenBuild =
  | {
      ok: true;
      modules: Record<string, string>;
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
  files: ReadonlySet<string>,
  typeFiles: ReadonlySet<string>
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
  const declarations = new Set(
    [...typeFiles].filter((typeFile) => declarationFile.test(typeFile))
  );
  for (const site of imports) {
    // A type may also name the App's declarations (`typeFiles`); a value
    // never does, as they compile to nothing.
    const message = site.typeOnly
      ? screenTypeImportError(site, path, typeFiles, kit)
      : (declarationValueImportError(site, path, { files, declarations }) ??
        importError(site, path, files, kit));
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

/**
 * Why an App's declaration file (`*.d.ts`) can't import what it does:
 * all it imports is types, held to what a screen's types may name
 * (`screenTypeImportError`) among `typeFiles`.
 */
const declarationImportErrors = (
  path: string,
  source: string,
  typeFiles: ReadonlySet<string>
): Diagnostic[] => {
  const imports: ImportSite[] = [];
  try {
    stripTypes(source, path, [collectImports(imports)]);
  } catch (error) {
    const message = messageIn(path, error);
    return [problem("compile", message, { file: path, ...locationOf(error) })];
  }
  return imports.flatMap((site) => {
    const { line } = site;
    const message = screenTypeImportError(site, path, typeFiles, kit);
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
 * What a screen's type check resolves an App file's imports to by name:
 * the kit's modules, its icons, and the JSX runtime the compile names.
 * Nothing else of the kit, however a file names it (type-check.ts).
 */
const screensTarget = screenTarget(
  new Set([...kit.imports, "lucide-react", "react/jsx-runtime"])
);

/**
 * Type-checks the App's screens against the kit's types and lints them
 * against the kit's design system: `buildScreens`' last gate, once its
 * import checks pass.
 */
const checkScreens = (files: Record<string, string>): Diagnostic[] => {
  const app = buildFiles(files);
  const tooMuch = appCodeLimitErrors(app);
  if (tooMuch.length > 0) {
    return tooMuch;
  }
  // The host wrote the references; the design system is the App's to keep.
  const own = Object.fromEntries(
    Object.entries(app).filter(([path]) => path !== screenReferences.path)
  );
  return [...typeCheck(app, kit.types, screensTarget), ...lint(own, kit)];
};

/**
 * Builds an App's screens: `screens/*.tsx`, the `components/` they use and
 * the declarations (`*.d.ts`) at the App's root and among its components,
 * which are types alone and never modules.
 */
export const buildScreens = async (
  files: Record<string, string>
): Promise<ScreenBuild> => {
  const app = buildFiles(files);
  const tooMuch = appCodeLimitErrors(app);
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
  // What a type may name: the build's files and its declarations.
  const typeFiles = new Set(Object.keys(app));
  const modules: Record<string, string> = {};
  const imports = new Map<string, ModuleImports>();
  const errors: Diagnostic[] = [];
  for (const [path, source] of sources) {
    const result = compileFile(path, source, known, typeFiles);
    if ("code" in result) {
      modules[appModuleName(path)] = result.code;
      imports.set(appModuleName(path), result.imported);
    } else {
      errors.push(...result.errors);
    }
  }
  // The App's declarations aren't modules, but they name modules for
  // their types: held to what a screen must never reach, as a screen's
  // own types are.
  for (const [path, source] of Object.entries(app)) {
    if (declarationFile.test(path)) {
      errors.push(...declarationImportErrors(path, source, typeFiles));
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
    sources
      .filter(([path]) => path !== screenReferences.path)
      .map(([, source]) => source),
    kitModules
  );
  return {
    ok: true,
    modules,
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
  const directives: DirectiveSite[] = [];
  let compiled: string;
  try {
    compiled = stripTypes(source, path, [
      collectImports(imports),
      collectDirectives(directives),
    ]);
  } catch (error) {
    const message = messageIn(path, error);
    return {
      errors: [
        problem("compile", message, { file: path, ...locationOf(error) }),
      ],
    };
  }
  // What would steer the type check of code whose types are checked
  // (`buildWorkflows`) rather than be checked by it: a triple-slash
  // directive reaches the whole program (a workflow's
  // `/// <reference lib="dom" />` would give every workflow the DOM), and
  // a suppression switches the check off.
  const steering =
    kind.typeChecked === true
      ? directives.map(({ directive, line }) =>
          problem(
            "imports",
            `${directive} is never in ${kind.name.toLowerCase()} code: its type check is the platform's, as it is, for all of them.`,
            line === undefined ? { file: path } : { file: path, line }
          )
        )
      : [];
  const errors = imports.flatMap(({ specifier, line, typeOnly, ambient }) => {
    const message = codeImportError(
      kind,
      { specifier, typeOnly, ambient },
      path,
      files
    );
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
  if (steering.length > 0 || errors.length > 0) {
    return { errors: [...steering, ...errors] };
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
 * The module the host generated from a JSON workflow, built: as one module
 * by flat name; or why it failed.
 */
export type OpenWorkflowBuild =
  | { ok: true; modules: Record<string, string> }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Builds the module the host generated from a JSON workflow
 * (`openWorkflowEntry`): type-checked against the SDK's own declarations,
 * then compiled as workflow code is, importing only
 * `@grasp-os/sdk/open-workflow` (`generatedWorkflowCode`). Generated code
 * is held to the type check that App workflows aren't (spec 19.1): it is
 * the host's own output, so a type error is the generator's, and nothing
 * is sealed that doesn't check.
 */
export const buildOpenWorkflow = (
  files: Record<string, string>
): OpenWorkflowBuild => {
  const wrong = openWorkflowErrors(files);
  if (wrong.length > 0) {
    return { ok: false, diagnostics: wrong };
  }
  const built = compileCode(generatedWorkflowCode, files);
  if (!built.ok) {
    return built;
  }
  const diagnostics = typeCheck(files, kit.types);
  return diagnostics.some((diagnostic) => isError(diagnostic))
    ? { ok: false, diagnostics }
    : built;
};

/**
 * A JSON workflow's compute modules, built: as modules by flat name; or
 * why they failed, each diagnostic naming its file.
 */
export type ComputeModulesBuild =
  | { ok: true; modules: Record<string, string> }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * The approved package entries core named among a compute build's files
 * (`computePackagesFile`), or why that list can't be read. Core writes
 * it; a workflow publishes only `code/`.
 */
const computePackagesOf = (
  listed: string | undefined
): { ok: true; packages: string[] } | { ok: false; message: string } => {
  if (listed === undefined) {
    return { ok: true, packages: [] };
  }
  let value: unknown;
  try {
    value = JSON.parse(listed);
  } catch {
    return { ok: false, message: "The approved packages aren't a list." };
  }
  const packages = Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" &&
          entry.length > 0 &&
          packageEntrySchema.safeParse(entry).success
      )
    : [];
  return Array.isArray(value) && packages.length === value.length
    ? { ok: true, packages }
    : { ok: false, message: "The approved packages aren't a list of names." };
};

/**
 * Builds a JSON workflow's compute modules (`code/<file>.ts`): compiled as
 * App workflow code is, importing only each other, the compute SDK and
 * the approved package entries their version seals, if any
 * (`computeCodeWith`, named by core in `computePackagesFile`), nothing in
 * them steering the check; and type-checked against that SDK's
 * declarations with a worker's lib (`computeTarget`), each package
 * entry as a module of no declared types (a package carries none). Their
 * errors are their author's.
 */
export const buildComputeModules = (
  input: Record<string, string>
): ComputeModulesBuild => {
  const { [computePackagesFile]: listed, ...files } = input;
  const named = computePackagesOf(listed);
  if (!named.ok) {
    return {
      ok: false,
      diagnostics: [
        { rule: "limits", severity: "error", message: named.message },
      ],
    };
  }
  const wrong = computeModuleErrors(files);
  if (wrong.length > 0) {
    return { ok: false, diagnostics: wrong };
  }
  const built = compileCode(computeCodeWith(named.packages), files);
  if (!built.ok) {
    return built;
  }
  const declared: Record<string, string> =
    named.packages.length === 0
      ? {}
      : {
          ".grasp/packages.d.ts": named.packages
            .map((entry) => `declare module ${JSON.stringify(entry)};`)
            .join("\n"),
        };
  const diagnostics = typeCheck(
    { ...files, ...declared },
    kit.types,
    computeTarget
  ).filter((diagnostic) => isError(diagnostic));
  return diagnostics.length > 0 ? { ok: false, diagnostics } : built;
};

/**
 * An App's server code of spec 8's layout (app-code.ts) as modules by
 * flat name, the host's generated modules among them; or why it failed.
 */
export type AppCodeBuild =
  | { ok: true; modules: Record<string, string> }
  | { ok: false; diagnostics: Diagnostic[] };

/** `typeImportError` for App code, as `appCodeImport` answers. */
const typeImportErrorAsResult = (
  path: string,
  specifier: string | undefined
): { module: undefined } | { error: string } => {
  const error = typeImportError(path, specifier, false);
  return error === undefined ? { module: undefined } : { error };
};

/** Compiles one file of an App's server code, or says why it can't be. */
const compileAppCodeFile = (
  path: string,
  source: string,
  files: ReadonlySet<string>
): { code: string } | { errors: Diagnostic[] } => {
  const imports: ImportSite[] = [];
  const directives: DirectiveSite[] = [];
  let compiled: string;
  try {
    compiled = stripTypes(source, path, [
      collectImports(imports),
      collectDirectives(directives),
    ]);
  } catch (error) {
    const message = messageIn(path, error);
    return {
      errors: [
        problem("compile", message, { file: path, ...locationOf(error) }),
      ],
    };
  }
  // What would steer the type check (`checkAppCode`) rather than be
  // checked by it: a triple-slash directive reaches the whole program (a
  // migration's `/// <reference lib="dom" />` would give every operation
  // the DOM), and a suppression switches the check off. Server code holds
  // neither, migrations and tests included.
  const steering = directives.map(({ directive, line }) =>
    problem(
      "imports",
      `${directive} is never in an App's server code: its type check is the platform's, as it is, for the whole App.`,
      line === undefined ? { file: path } : { file: path, line }
    )
  );
  const errors = imports.flatMap(({ specifier, line, typeOnly, ambient }) => {
    // An ambient module would declare, or shadow, a module by name in the
    // type check (`checkAppCode`): server code declares none. A type is
    // erased: held only to what no App code may name.
    if (ambient) {
      return [
        problem(
          "imports",
          specifier === undefined
            ? "declare global is never in an App's server code: it would declare globals its isolate doesn't have, for every file."
            : `declare module "${specifier}" is never in an App's server code: it would declare, or shadow, a module the SDK doesn't give it.`,
          line === undefined ? { file: path } : { file: path, line }
        ),
      ];
    }
    const resolved = typeOnly
      ? typeImportErrorAsResult(path, specifier)
      : appCodeImport(path, specifier, files);
    return "error" in resolved
      ? [
          problem(
            "imports",
            resolved.error,
            line === undefined ? { file: path } : { file: path, line }
          ),
        ]
      : [];
  });
  if (steering.length > 0 || errors.length > 0) {
    return { errors: [...steering, ...errors] };
  }
  try {
    return {
      code: transformModule(compiled, path, [
        rewriteAppCodeImports(path, files),
      ]),
    };
  } catch (error) {
    return {
      errors: [problem("imports", messageIn(path, error), { file: path })],
    };
  }
};

/**
 * Builds an App's server code of spec 8's layout: its schema, values,
 * registration and operations, with the modules the host generated for
 * it (`.grasp/`), each held to what its kind may import. Types are
 * stripped, not checked.
 */
export const buildAppCode = (files: Record<string, string>): AppCodeBuild => {
  const code = appCodeFiles(files);
  const tooMuch = appCodeLimitErrors(code);
  if (tooMuch.length > 0) {
    return { ok: false, diagnostics: tooMuch };
  }
  // Nothing under operations/ is passed over: what isn't server code is
  // refused, by name.
  const strays = strayServerFiles(code);
  if (strays.length > 0) {
    return {
      ok: false,
      diagnostics: strays.map((file) =>
        problem("server", strayServerFileMessage(file), { file })
      ),
    };
  }
  if (!isAppLayout(code)) {
    return {
      ok: false,
      diagnostics: [
        problem(
          "server",
          "The App has no app.ts and schema.ts: register it in app.ts and declare its schema in schema.ts."
        ),
      ],
    };
  }
  const known = new Set(Object.keys(code));
  const modules: Record<string, string> = {};
  const errors: Diagnostic[] = [];
  // Only server code becomes a module, whatever else is passed: what isn't
  // is refused above, and never compiled, should that check ever miss it.
  const compiled = Object.entries(code).filter(
    ([path]) => appCodeKind(path) !== undefined
  );
  const named = new Map<string, string>();
  for (const [path, source] of compiled) {
    const name = appModuleName(path);
    const taken = named.get(name);
    if (taken !== undefined) {
      errors.push(
        problem(
          "server",
          `${path} would load as the same module as ${taken}: rename one of them.`,
          { file: path }
        )
      );
      continue;
    }
    named.set(name, path);
    const result = compileAppCodeFile(path, source, known);
    if ("code" in result) {
      modules[name] = result.code;
    } else {
      errors.push(...result.errors);
    }
  }
  return errors.length > 0
    ? { ok: false, diagnostics: errors }
    : { ok: true, modules };
};

/**
 * Builds an App's workflows: the TypeScript files under `workflows/`,
 * their tests included, importing only those files and the SDK's
 * workflow modules (`sdkImports`), then type-checked in one program
 * against those modules' declarations (`workflowTarget`), with the App's
 * server code their types may name (`workflowTypeContext`): what they
 * build to, or why they fail, their type errors included. Every place a
 * workflow runs builds it here first: as its version is made current,
 * before its tests run; as a run loads it; and as a save is built.
 */
export const buildWorkflows = (
  files: Record<string, string>
): WorkflowBuild => {
  const workflows = workflowFiles(files);
  const context = workflowTypeContext(files);
  const tooMuch = appCodeLimitErrors({ ...context, ...workflows });
  if (tooMuch.length > 0) {
    return { ok: false, diagnostics: tooMuch };
  }
  const built = compileCode(workflowCode, workflows);
  if (!built.ok) {
    return built;
  }
  // The App's server code joins the check only as it builds (what server
  // code may import and name, no directive, suppression or ambient
  // module), so none of it can steer the workflows' check; its own type
  // errors are its seal's (`checkAppCode`), never a workflow's. Server
  // code that doesn't build stays out, and a workflow that names it is
  // told why its types are missing.
  const layout = isAppLayout(context);
  const serverBuilds = layout && buildAppCode(context).ok;
  const diagnostics = typeCheck(
    serverBuilds ? { ...context, ...workflows } : workflows,
    kit.types,
    workflowTarget
  ).filter(({ file }) => file === undefined || Object.hasOwn(workflows, file));
  if (!diagnostics.some((diagnostic) => isError(diagnostic))) {
    return built;
  }
  return {
    ok: false,
    diagnostics:
      layout && !serverBuilds
        ? [
            ...diagnostics,
            {
              rule: "server",
              severity: "warning",
              message:
                "The App's server code doesn't build, so its types aren't in this check: a workflow that names them (appFunctions<Tree>(env), import type from operations/) can't find them until it builds.",
            },
          ]
        : diagnostics,
  };
};

/**
 * Builds an App's tests (`tests/**`), each held to what a test may import
 * (app-code.ts): only the test files become modules. The schema and
 * values they import, and the `#grasp` references, are the release's own
 * modules, which core loads with them. Types are stripped, not checked.
 */
export const buildAppTests = (files: Record<string, string>): AppCodeBuild => {
  const code = appTestFiles(files);
  const tooMuch = limitErrors(code);
  if (tooMuch.length > 0) {
    return { ok: false, diagnostics: tooMuch };
  }
  // Nothing under tests/ is passed over: what isn't a suite, a helper or a
  // fixture is refused, by name.
  const strays = strayTestFiles(code);
  if (strays.length > 0) {
    return {
      ok: false,
      diagnostics: strays.map((file) =>
        problem("tests", strayTestFileMessage(file), { file })
      ),
    };
  }
  // The same suites core runs (`isAppTestSuite`).
  const suites = Object.keys(code).filter(isAppTestSuite).length;
  if (suites > maxAppTestSuites) {
    return {
      ok: false,
      diagnostics: [
        problem(
          "tests",
          `An App has at most ${maxAppTestSuites} test suites (tests/**.test.ts); this one has ${suites}. Put more tests in each suite.`
        ),
      ],
    };
  }
  const known = new Set(Object.keys(code));
  const modules: Record<string, string> = {};
  const errors: Diagnostic[] = [];
  for (const [path, source] of Object.entries(code)) {
    if (appCodeKind(path) === "test") {
      const result = compileAppCodeFile(path, source, known);
      if ("code" in result) {
        modules[appModuleName(path)] = result.code;
      } else {
        errors.push(...result.errors);
      }
    }
  }
  return errors.length > 0
    ? { ok: false, diagnostics: errors }
    : { ok: true, modules };
};

/**
 * An App's server code of spec 8's layout built (`buildAppCode`), then
 * type-checked against the SDK's server side, with the host's generated
 * modules (`.grasp/`) among its files: what it would build to, or why it
 * fails, its type errors included. No DOM: its isolate has none. A seal
 * holds its release to this before anything is sealed (app-releases.ts);
 * a build alone, as the seal's first, symbolic inspection makes it,
 * doesn't, since its generated modules are stand-ins without types.
 */
export const checkAppCode = (files: Record<string, string>): AppCodeBuild => {
  const built = buildAppCode(files);
  if (!built.ok) {
    return built;
  }
  // Its tests, checked in the same program: their `#grasp` is the
  // references generated for this very release, which exist only here.
  // Only tests that build (`buildAppTests`: what a test may import and
  // name, no directive, suppression or ambient module) join it, so none
  // can steer the server code's check; tests that don't build are
  // refused where they run, as a version is made current (app-tests.ts).
  const candidates = Object.fromEntries(
    Object.entries(files).filter(([path]) => appCodeKind(path) === "test")
  );
  const tests =
    Object.keys(candidates).length > 0 && buildAppTests(files).ok
      ? candidates
      : {};
  // Its migrations included: a migration's row is typed as the previous
  // shape it declares (`input`), or as the stored JSON it is handed when
  // it declares none, so a correct one checks and a wrong output fails here,
  // before the host refuses it at run time anyway.
  const diagnostics = typeCheck(
    { ...appCodeFiles(files), ...tests },
    kit.types,
    appCodeTarget
  );
  return diagnostics.some((diagnostic) => isError(diagnostic))
    ? { ok: false, diagnostics }
    : built;
};

/**
 * What the compiler builds: an App's screens, its v1 server (`app/`), its
 * server code of spec 8's layout (`app`), its tests, its workflows, a
 * JSON workflow's generated module and its compute modules.
 */
export type CompileTarget =
  | "screens"
  | "server"
  | "app"
  | "app-tests"
  | "workflows"
  | "open-workflow"
  | "compute";

/** What a build of each target answers. */
export interface TargetBuilds {
  screens: ScreenBuild;
  server: ServerBuild;
  app: AppCodeBuild;
  "app-tests": AppCodeBuild;
  workflows: WorkflowBuild;
  "open-workflow": OpenWorkflowBuild;
  compute: ComputeModulesBuild;
}

/**
 * Each target's build, with every gate it has: for `app`, the server code
 * type-checked against the host's real generated modules, as a seal holds
 * a release to it (`checkAppCode`).
 */
const targetBuilds: {
  readonly [Target in CompileTarget]: (
    files: Record<string, string>
  ) => TargetBuilds[Target] | Promise<TargetBuilds[Target]>;
} = {
  screens: buildScreens,
  server: buildServer,
  app: checkAppCode,
  "app-tests": buildAppTests,
  workflows: buildWorkflows,
  "open-workflow": buildOpenWorkflow,
  compute: buildComputeModules,
};

/** The targets contract inspection loads, and what it builds of each. */
export interface TargetInspections {
  app: AppCodeBuild;
}

/** What `inspect` builds a target to. */
export type InspectTarget = keyof TargetInspections;

/**
 * What contract inspection (spec 19.1) loads to read what the App
 * registers, before anything is generated for it: its server code built
 * with stand-in generated modules, whose types are stripped, not checked
 * (`buildAppCode`). Never what a release is sealed from.
 */
const targetInspections: {
  readonly [Target in InspectTarget]: (
    files: Record<string, string>
  ) => TargetInspections[Target];
} = {
  app: buildAppCode,
};

/**
 * The target `target` names, or an error: a call names it as a string over
 * RPC, and one the compiler doesn't know never falls through to another.
 */
const knownTarget = <Target extends string>(
  table: Readonly<Record<Target, unknown>>,
  target: unknown,
  what: string
): Target => {
  if (typeof target !== "string" || !Object.hasOwn(table, target)) {
    throw new TypeError(
      `${what} has no target ${JSON.stringify(target)}: it takes ${Object.keys(table).join(", ")}.`
    );
  }
  // SAFETY: `target` is one of `table`'s own keys, checked just above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return target as Target;
};

/**
 * The App compiler, in an isolate of its own: it parses, checks and
 * transforms App code, and never runs it. Each method takes the target it
 * acts on, and nothing else is exposed.
 */
export default class AppCompiler extends WorkerEntrypoint {
  /**
   * Builds `target` from `files`, with every gate the target has (type
   * check, lint, import boundaries, limits): its output, or why it fails.
   */
  // RPC exposes prototype methods only, so these can't be static.
  async build<Target extends CompileTarget>(
    target: Target,
    files: Record<string, string>
  ): Promise<TargetBuilds[Target]> {
    assertNoBindings(this.env, this.ctx.props, "The App compiler");
    const known = knownTarget(targetBuilds, target, "build");
    // SAFETY: `known` is `target`, which picks its own builder.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return (await targetBuilds[known](files)) as TargetBuilds[Target];
  }

  /**
   * What `build(target, files)` says, without its output: every diagnostic
   * the build gives (a passing screens build carries its lint warnings;
   * other passing builds carry none). Derived from the build itself, so it
   * is never clean where the build refuses.
   */
  async check(
    target: CompileTarget,
    files: Record<string, string>
  ): Promise<Diagnostic[]> {
    knownTarget(targetBuilds, target, "check");
    const built = await this.build(target, files);
    return "diagnostics" in built ? built.diagnostics : [];
  }

  /**
   * Builds `target` as contract inspection loads it (`targetInspections`):
   * only `app` has one.
   */
  inspect<Target extends InspectTarget>(
    target: Target,
    files: Record<string, string>
  ): TargetInspections[Target] {
    assertNoBindings(this.env, this.ctx.props, "The App compiler");
    const known = knownTarget(targetInspections, target, "inspect");
    return targetInspections[known](files);
  }
}
