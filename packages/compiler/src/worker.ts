/**
 * The App compiler, as it runs in its own isolate (a Dynamic Worker, one
 * per build). It has no bindings and no network: it reads the files it is
 * given and what it knows of the kit, nothing else.
 *
 * Each App file becomes one ES module: Babel runs the React Compiler,
 * strips types and turns JSX into calls, then points imports at flat module
 * names (see kit.ts). There is no bundler: the kit's modules are built once
 * per release and shared by every App, and a build says which of them, and
 * which of the App's own, each screen loads. The App is type-checked and
 * linted against the kit's design system whatever the compile found, so a
 * build names everything there is to fix at once; once it all passes,
 * Tailwind compiles the CSS for the classes in the App's sources and in the
 * kit modules it loads.
 *
 * It also builds an App's workflows, which run in core (see
 * `buildWorkflows`): the same Babel, stripping types only.
 */
import { packageEntrySchema } from "@grasp-os/shared/packages";
import { WorkerEntrypoint } from "cloudflare:workers";
import { build as esbuild } from "esbuild-wasm/esm/browser.js";
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
  serverCodeFolders,
  serverEntryPath,
  serverEntrySource,
  strayTestFileMessage,
  strayTestFiles,
  typeImportError,
  workflowBindingsPath,
  workflowBindingsSchema,
  workflowEnvDeclaration,
  workflowEnvPath,
  workflowTypeContext,
} from "./app-code.ts";
import { assertNoBindings } from "./authority.ts";
import { extractCandidates } from "./candidates.ts";
import type { TypeCheckPlan, Unchecked } from "./checked-build.ts";
import {
  compileModule,
  refreshNames,
  stripTypes,
  transformModule,
} from "./compile.ts";
import { isError, together } from "./diagnostic.ts";
import type { Diagnostic } from "./diagnostic.ts";
import esbuildWasm from "./esbuild.wasm";
import { startOxcParser } from "./eslint-parser.ts";
import {
  collectDirectives,
  collectImports,
  declarationValueImportError,
  importError,
  codeImportError,
  typeFileError,
  rewriteAppCodeImports,
  rewriteCodeImports,
  computeCodeWith,
  generatedWorkflowCode,
  rewriteImports,
  screenTypeImportError,
  workflowCode,
} from "./imports.ts";
import type { CodeKind, ImportSite, ModuleImports } from "./imports.ts";
import {
  moduleKey,
  moduleRecordOf,
  noIncrements,
  screenSources,
} from "./increments.ts";
import type {
  BuildMetrics,
  Handed,
  IncrementalBuild,
  ModuleRecord,
} from "./increments.ts";
import {
  appCodeLimitErrors,
  buildFiles,
  declarationFile,
  limitErrors,
  computeModuleErrors,
  openWorkflowErrors,
  screenFile,
  workflowFiles,
  workflowsFolder,
} from "./inputs.ts";
import {
  appModuleName,
  computePackagesFile,
  kitModuleName,
  kitStylesheet,
  ownEntry,
  previewRefresh,
  previewRuntime,
  screenReferences,
  screenRuntime,
} from "./kit.ts";
import { lint } from "./lint.ts";
import oxcParserWasm from "./oxc-parser.wasm";
import { startEsbuild } from "./packages/build.ts";
import { previewEntries } from "./preview-entry.ts";
import type { Bundle } from "./preview-entry.ts";
import { problem, screenRefusals, strayProblems } from "./refusals.ts";
import type { Location } from "./refusals.ts";
import { lintServerCode } from "./server-lint.ts";
import { callbackParameters, readsStandIns } from "./stand-ins.ts";
import { referenceError } from "./steering.ts";
import type { DirectiveSite } from "./steering.ts";
import {
  appCodeTarget,
  computeTarget,
  screenTarget,
  typeCheckRequest,
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
      /**
       * A preview build's (`preview-screens`): each screen's App modules
       * put together into one entry (preview-entry.ts), by its module's
       * name, which the preview frame evaluates for an update.
       */
      entries?: Record<string, string>;
    }
  | { ok: false; diagnostics: Diagnostic[] };

/** The line a React Compiler error points at in its code frame: `> 3 |`. */
const framedLine = /^> *(?<line>\d+) \|/mu;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

/**
 * Whether Babel's parser refused the source: @babel/core marks what its
 * parser threw `BABEL_PARSE_ERROR`. The file has no syntax tree, so
 * nothing checked past the break is to be trusted. Never a React Compiler
 * error, nor any other of a file that parsed.
 */
const parseFailed = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  Reflect.get(error, "code") === "BABEL_PARSE_ERROR";

/** A compile error's message, in words for whoever fixes the file. */
const compileMessage = (message: string): string =>
  message.includes("Handle Import expressions")
    ? "import() can't be used inside a component or hook: import the module at the top of the file."
    : message;

/**
 * An error's message without the file Babel names in it (as `/<path>`):
 * the diagnostic names it on its own.
 */
const messageIn = (path: string, error: unknown): string =>
  messageOf(error).replace(`/${path}: `, "").replace(`${path}: `, "");

/**
 * What a preview build's module starts with (spec 19.2.1): the names the
 * Refresh instrumentation calls (`refreshNames`), bound to the preview
 * kit's registry, each component's family its file's path and its name.
 */
const refreshHeader = (path: string): string =>
  `import{register as __graspRefreshRegister,signature as ${refreshNames.signature}}from${JSON.stringify(kitModuleName(previewRefresh))};const ${refreshNames.register}=(type,id)=>__graspRefreshRegister(type,${JSON.stringify(`${path} `)}+id);`;

/** Where a directive is in `file`, as a diagnostic points at it. */
const directiveAt = (
  file: string,
  { line, column }: DirectiveSite
): Location => {
  if (line === undefined) {
    return { file };
  }
  return column === undefined ? { file, line } : { file, line, column };
};

/**
 * What a screen's or a declaration's triple-slash directives reach beyond
 * the App's files (steering.ts `referenceError`), each refused where it is.
 */
const referenceErrors = (
  path: string,
  directives: readonly DirectiveSite[],
  files: ReadonlySet<string>
): Diagnostic[] =>
  directives.flatMap((site) => {
    const message = referenceError(site.directive, path, files);
    return message === undefined
      ? []
      : [problem("imports", message, directiveAt(path, site))];
  });

/**
 * Compiles one App file, with what it imports, or says why it can't be:
 * with `refresh`, for a preview, instrumented for React Fast Refresh. A
 * file the parser refuses is added to `unparsed`, and one whose compiled
 * code imports what its source doesn't (a refused JSX runtime) to
 * `untyped` (`together`).
 */
const compileFile = (
  path: string,
  source: string,
  files: ReadonlySet<string>,
  typeFiles: ReadonlySet<string>,
  { unparsed, untyped }: { unparsed: Set<string>; untyped: Set<string> },
  refresh = false
): { code: string; imported: ModuleImports } | { errors: Diagnostic[] } => {
  const imports: ImportSite[] = [];
  const directives: DirectiveSite[] = [];
  let compiled: string;
  try {
    compiled = compileModule(
      source,
      path,
      [collectImports(imports), collectDirectives(directives)],
      { refresh }
    );
  } catch (error) {
    if (parseFailed(error)) {
      unparsed.add(path);
    }
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
  const errors = referenceErrors(path, directives, typeFiles);
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
    const code = transformModule(compiled, path, [
      rewriteImports(path, files, kit, imported),
    ]);
    if (!refresh) {
      return { code, imported };
    }
    imported.kit.add(kitModuleName(previewRefresh));
    return { code: `${refreshHeader(path)}${code}`, imported };
  } catch (error) {
    // An import only the compiled code makes, refused: its JSX runtime.
    untyped.add(path);
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
  typeFiles: ReadonlySet<string>,
  unparsed: Set<string>
): Diagnostic[] => {
  const imports: ImportSite[] = [];
  const directives: DirectiveSite[] = [];
  try {
    stripTypes(source, path, [
      collectImports(imports),
      collectDirectives(directives),
    ]);
  } catch (error) {
    if (parseFailed(error)) {
      unparsed.add(path);
    }
    const message = messageIn(path, error);
    return [problem("compile", message, { file: path, ...locationOf(error) })];
  }
  return [
    ...referenceErrors(path, directives, typeFiles),
    ...imports.flatMap((site) => {
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
    }),
  ];
};

/**
 * The transform of the screen source `path`, as a build keeps it, or why
 * it can't be (`compileFile`), in a build whose modules are `known` and
 * whose types may name `typeFiles`.
 */
const transformSource = (
  path: string,
  source: string,
  {
    known,
    typeFiles,
  }: { known: ReadonlySet<string>; typeFiles: ReadonlySet<string> },
  flags: { unparsed: Set<string>; untyped: Set<string> },
  preview: boolean
): { record: ModuleRecord } | { errors: Diagnostic[] } => {
  const result = compileFile(path, source, known, typeFiles, flags, preview);
  if (!("code" in result)) {
    return result;
  }
  return {
    record: {
      path,
      code: result.code,
      app: [...result.imported.app],
      kit: [...result.imported.kit],
      // The references' classes are the host's, never a screen's.
      candidates:
        path === screenReferences.path ? [] : extractCandidates(source),
    },
  };
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
const kitModulesFor = (
  imported: Iterable<string>,
  preview = false
): string[] =>
  preview
    ? closureOf(
        // The preview runtime loads the screen runtime by name, once
        // React Fast Refresh is in (sdk/src/preview-runtime.ts).
        [
          ...imported,
          kitModuleName(previewRuntime),
          kitModuleName(screenRuntime),
        ],
        (name) => ownEntry(kit.previewModuleImports, name) ?? []
      )
    : closureOf(
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
  imports: ReadonlyMap<string, ModuleImports>,
  preview = false
): ScreenClosure => {
  const modules = closureOf([entry], (name) => imports.get(name)?.app ?? []);
  return {
    modules,
    kitModules: kitModulesFor(
      modules.flatMap((name) => [...(imports.get(name)?.kit ?? [])]),
      preview
    ),
  };
};

/**
 * The CSS for the kit's theme and every class used by the App and by the
 * kit modules it loads (`kitModules`).
 */
const buildCss = async (
  candidates: string[],
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
    ...candidates,
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

/** `record`'s own entry for `key`, never one it inherits. */
const ownRecord = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/**
 * The type check of the App's screens against the kit's types, which core
 * runs in the checker's isolate (checked-build.ts), and their lint
 * against the kit's design system, which runs here over every file:
 * `buildScreens`' last gates, beside its compile and import checks.
 */
const screensCheck = (
  files: Record<string, string>,
  {
    found,
    unparsed,
    untyped,
  }: {
    found: Diagnostic[];
    unparsed: ReadonlySet<string>;
    untyped: ReadonlySet<string>;
  }
): TypeCheckPlan & { after: Diagnostic[] } => {
  const app = buildFiles(files);
  // The host wrote the references; the design system is the App's to keep.
  const own = Object.fromEntries(
    Object.entries(app).filter(([path]) => path !== screenReferences.path)
  );
  return {
    request: typeCheckRequest(app, screensTarget),
    found,
    after: lint(own, kit),
    unparsed: [...unparsed],
    untyped: [...untyped],
    lenient: readsStandIns(app) ? callbackParameters(app) : [],
    carries: true,
  };
};

/**
 * esbuild, started on the WebAssembly module this isolate was loaded with
 * (`esbuild.wasm`), once: what bundles a preview's entries
 * (preview-entry.ts). Started on a preview's first build, so a build that
 * bundles nothing never pays for it.
 */
const bundle: Bundle = async (options) => {
  await startEsbuild(esbuildWasm);
  return await esbuild(options);
};

/**
 * Builds an App's screens: `screens/*.tsx`, the `components/` they use and
 * the declarations (`*.d.ts`) at the App's root and among its components,
 * which are types alone and never modules.
 *
 * With `preview`, for a chat's draft (spec 19.2.1): each module is
 * instrumented for React Fast Refresh, what a screen loads of the kit is
 * the preview kit's, and each screen's App modules are put together into
 * one entry too (`ScreenBuild.entries`). Every gate is the same.
 *
 * Without `checks`, for a preview's frame only (`preview-frame`), the
 * type check and the lint don't run: they hold up nothing the frame
 * needs, and the agent hears them from its own check of the draft
 * (`preview-screens`, which has them). Neither is a boundary: what a
 * file may import is held at its compile, which runs either way, and the
 * frame's sandbox and policy hold whatever the code does.
 *
 * With `reuse`, what earlier builds kept (increments.ts): a module's
 * transform, only where its key says it stands for what this build would
 * make. What it makes now it hands back (`fresh`) for core to keep, with
 * how much it reused (`metrics`).
 *
 * Its type check is core's to run, in the checker's isolate: the build
 * says what it checks (`Unchecked`), and core puts the two together
 * (checked-build.ts `withTypeCheck`).
 */
export const buildScreensIncrementally = async (
  files: Record<string, string>,
  {
    preview = false,
    checks = true,
    reuse = noIncrements(),
  }: { preview?: boolean; checks?: boolean; reuse?: Handed } = {}
): Promise<IncrementalBuild<Unchecked<ScreenBuild>>> => {
  const fresh = noIncrements();
  const metrics: BuildMetrics = { compiled: 0, reused: 0 };
  const done = (
    built: ScreenBuild,
    typeCheck?: TypeCheckPlan
  ): IncrementalBuild<Unchecked<ScreenBuild>> => ({
    built: typeCheck === undefined ? { built } : { built, typeCheck },
    fresh,
    metrics,
  });
  const app = buildFiles(files);
  const tooMuch = appCodeLimitErrors(app);
  if (tooMuch.length > 0) {
    return done({ ok: false, diagnostics: tooMuch });
  }
  const refused = screenRefusals(app);
  if (refused.length > 0) {
    return done({ ok: false, diagnostics: refused });
  }
  // Only screens, components and the references they import are
  // compiled, whatever else is passed: what isn't is refused above, and
  // kept out should that ever miss it. Declarations are only types.
  const { sources, known: paths, typeFiles: typed } = screenSources(app);
  const known = new Set(paths);
  // What a type may name: the build's files and its declarations.
  const typeFiles = new Set(typed);
  const modules: Record<string, string> = {};
  const imports = new Map<string, ModuleImports>();
  const candidates: string[] = [];
  const errors: Diagnostic[] = [];
  // The files the parser refused, whose checks past the break are guesses.
  const unparsed = new Set<string>();
  // The files whose JSX runtime was refused, whose types are its guesses.
  const untyped = new Set<string>();
  const keyed = await Promise.all(
    sources.map(
      async ([path, source]) =>
        [
          path,
          source,
          await moduleKey({
            path,
            source,
            known: paths,
            typeFiles: typed,
            preview,
          }),
        ] as const
    )
  );
  const take = (record: ModuleRecord): void => {
    const name = appModuleName(record.path);
    modules[name] = record.code;
    imports.set(name, { app: new Set(record.app), kit: new Set(record.kit) });
    candidates.push(...record.candidates);
  };
  for (const [path, source, key] of keyed) {
    // A transform is reused only under the key this build works out for
    // it: one handed over under another, or shaped otherwise, is not.
    const kept = moduleRecordOf(ownRecord(reuse.modules, key), path);
    if (kept !== undefined) {
      take(kept);
      metrics.reused += 1;
      continue;
    }
    const result = transformSource(
      path,
      source,
      { known, typeFiles },
      { unparsed, untyped },
      preview
    );
    if ("record" in result) {
      take(result.record);
      fresh.modules[key] = result.record;
      metrics.compiled += 1;
    } else {
      errors.push(...result.errors);
    }
  }
  // The App's declarations aren't modules, but they name modules for
  // their types: held to what a screen must never reach, as a screen's
  // own types are.
  for (const [path, source] of Object.entries(app)) {
    if (declarationFile.test(path)) {
      errors.push(
        ...declarationImportErrors(path, source, typeFiles, unparsed)
      );
    }
  }
  // The type check and the lint run whatever the compile found, so one
  // build names everything there is to fix; only what says a compile
  // error again is left out (`together`). A preview's frame skips both
  // (`checks`): its compile errors still fail it, and it never starts the
  // lint's parser.
  if (checks) {
    await startOxcParser(oxcParserWasm);
  }
  const typeCheck = checks
    ? screensCheck(files, { found: errors, unparsed, untyped })
    : undefined;
  const diagnostics = together(
    errors,
    typeCheck?.after ?? [],
    unparsed,
    untyped
  );
  if (diagnostics.some((diagnostic) => isError(diagnostic))) {
    return done({ ok: false, diagnostics }, typeCheck);
  }
  const kitModules = kitModulesFor(
    [...imports.values()].flatMap(({ kit: imported }) => [...imported])
  );
  const css = await buildCss(candidates, kitModules);
  const screens: Record<string, ScreenClosure> = Object.fromEntries(
    paths
      .filter((path) => screenFile.test(path))
      .map((path) => appModuleName(path))
      .map((entry) => [entry, screenClosure(entry, imports, preview)])
  );
  return done(
    {
      ok: true,
      modules,
      screens,
      css,
      diagnostics,
      ...(preview
        ? {
            entries: await previewEntries(
              {
                screens: Object.fromEntries(
                  Object.entries(screens).map(([entry, closure]) => [
                    entry,
                    {
                      closure: closure.modules,
                      kitModules: closure.modules.flatMap((name) => [
                        ...(imports.get(name)?.kit ?? []),
                      ]),
                    },
                  ])
                ),
                modules,
              },
              bundle
            ),
          }
        : {}),
    },
    typeCheck
  );
};

/**
 * Transforms part of a screens build's sources (`batch`), in a build whose
 * modules are `known` and whose types may name `typeFiles`: each as
 * `buildScreensIncrementally` would, under the key it would work out for
 * it, so the build reuses it. What a first build of a large App does a
 * part at a time, each part one call within a call's CPU time (core's
 * screens.ts). Only `known` sources are transformed, whatever else is
 * passed. A file that doesn't compile is left out: the build compiles it
 * again and says why, with every gate.
 */
const transformScreens = async (
  batch: Record<string, string>,
  { known, typeFiles }: { known: string[]; typeFiles: string[] },
  preview: boolean
): Promise<Record<string, ModuleRecord>> => {
  const sets = { known: new Set(known), typeFiles: new Set(typeFiles) };
  const flags = { unparsed: new Set<string>(), untyped: new Set<string>() };
  const records = await Promise.all(
    Object.entries(batch)
      .filter(([path]) => sets.known.has(path))
      .map(async ([path, source]) => {
        const result = transformSource(path, source, sets, flags, preview);
        if (!("record" in result)) {
          return [];
        }
        const key = await moduleKey({
          path,
          source,
          known,
          typeFiles,
          preview,
        });
        return [[key, result.record] as const];
      })
  );
  return Object.fromEntries(records.flat());
};

/** Builds an App's screens with nothing reused (`buildScreensIncrementally`). */
export const buildScreens = async (
  files: Record<string, string>,
  {
    preview = false,
    checks = true,
  }: { preview?: boolean; checks?: boolean } = {}
): Promise<Unchecked<ScreenBuild>> => {
  const { built } = await buildScreensIncrementally(files, { preview, checks });
  return built;
};

/** Compiles one server or workflow file, or says why it can't be. */
const compileCodeFile = (
  kind: CodeKind,
  path: string,
  source: string,
  files: ReadonlySet<string>,
  typeFiles: ReadonlySet<string>
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
      ? directives.map((site) =>
          problem(
            "imports",
            `${site.directive} is never in ${kind.name.toLowerCase()} code: its type check is the platform's, as it is, for all of them.`,
            directiveAt(path, site)
          )
        )
      : [];
  const errors = imports.flatMap(({ specifier, line, typeOnly, ambient }) => {
    const message = codeImportError(
      kind,
      { specifier, typeOnly, ambient },
      path,
      files,
      typeFiles
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

/**
 * App code compiled file by file, as modules by flat name, its types
 * naming by path only `typeFiles` (every file the build was given).
 */
const compileCode = (
  kind: CodeKind,
  files: Record<string, string>,
  typeFiles: ReadonlySet<string> = new Set(Object.keys(files))
): WorkflowBuild => {
  const known = new Set(Object.keys(files));
  const modules: Record<string, string> = {};
  const errors: Diagnostic[] = [];
  for (const [path, source] of Object.entries(files)) {
    const result = compileCodeFile(kind, path, source, known, typeFiles);
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
): Unchecked<OpenWorkflowBuild> => {
  const wrong = openWorkflowErrors(files);
  if (wrong.length > 0) {
    return { built: { ok: false, diagnostics: wrong } };
  }
  const built = compileCode(generatedWorkflowCode, files);
  return built.ok
    ? { built, typeCheck: { request: typeCheckRequest(files) } }
    : { built };
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
): Unchecked<ComputeModulesBuild> => {
  const { [computePackagesFile]: listed, ...files } = input;
  const named = computePackagesOf(listed);
  if (!named.ok) {
    return {
      built: {
        ok: false,
        diagnostics: [
          { rule: "limits", severity: "error", message: named.message },
        ],
      },
    };
  }
  const wrong = computeModuleErrors(files);
  if (wrong.length > 0) {
    return { built: { ok: false, diagnostics: wrong } };
  }
  const built = compileCode(computeCodeWith(named.packages), files);
  if (!built.ok) {
    return { built };
  }
  const declared: Record<string, string> =
    named.packages.length === 0
      ? {}
      : {
          ".grasp/packages.d.ts": named.packages
            .map((entry) => `declare module ${JSON.stringify(entry)};`)
            .join("\n"),
        };
  return {
    built,
    typeCheck: {
      request: typeCheckRequest({ ...files, ...declared }, computeTarget),
      errorsOnly: true,
    },
  };
};

/**
 * An App's server code of spec 8's layout (app-code.ts) as modules by
 * flat name, the host's generated modules among them; or why it failed.
 */
export type AppCodeBuild =
  | { ok: true; modules: Record<string, string> }
  | { ok: false; diagnostics: Diagnostic[] };

/** `typeImportError` and `typeFileError` for App code, as `appCodeImport` answers. */
const typeImportErrorAsResult = (
  path: string,
  specifier: string | undefined,
  typeFiles: ReadonlySet<string>
): { module: undefined } | { error: string } => {
  const error =
    typeImportError(path, specifier, false) ??
    typeFileError(path, specifier, typeFiles);
  return error === undefined ? { module: undefined } : { error };
};

/**
 * Compiles one file of an App's server code, or says why it can't be. A
 * file the parser refuses is added to `unparsed` (`together`).
 */
const compileAppCodeFile = (
  path: string,
  source: string,
  files: ReadonlySet<string>,
  unparsed: Set<string>,
  /** What its types may name by path: every file the build was given. */
  typeFiles: ReadonlySet<string> = files
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
    if (parseFailed(error)) {
      unparsed.add(path);
    }
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
  const steering = directives.map((site) =>
    problem(
      "imports",
      `${site.directive} is never in an App's server code: its type check is the platform's, as it is, for the whole App.`,
      directiveAt(path, site)
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
      ? typeImportErrorAsResult(path, specifier, typeFiles)
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
      code: transformModule(
        compiled,
        path,
        [rewriteAppCodeImports(path, files)],
        { retainLines: true }
      ),
    };
  } catch (error) {
    return {
      errors: [problem("imports", messageIn(path, error), { file: path })],
    };
  }
};

/** `buildAppCode` (below), adding each file the parser refuses to `unparsed`. */
const buildAppCodeNoting = (
  files: Record<string, string>,
  unparsed: Set<string>
): AppCodeBuild => {
  const code = appCodeFiles(files);
  const tooMuch = appCodeLimitErrors(code);
  if (tooMuch.length > 0) {
    return { ok: false, diagnostics: tooMuch };
  }
  // Nothing under server/ is passed over: what isn't server code is
  // refused, by name.
  const strays = strayProblems(code, serverCodeFolders, "server");
  if (strays.length > 0) {
    return { ok: false, diagnostics: strays };
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
  // The entry the host runs the App from, made from its file list: its
  // registration with every server module's functions. Built as the
  // host's own code, never type-checked as the App's.
  code[serverEntryPath] = serverEntrySource(Object.keys(code));
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
    const result = compileAppCodeFile(path, source, known, unparsed);
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
 * Builds an App's server code of spec 8's layout: its schema, values,
 * registration and operations, with the modules the host generated for
 * it (`.grasp/`), each held to what its kind may import. Types are
 * stripped, not checked.
 */
export const buildAppCode = (files: Record<string, string>): AppCodeBuild =>
  buildAppCodeNoting(files, new Set());

/**
 * The declaration of the App's workflow bindings its workflows are
 * type-checked with (`workflowEnvDeclaration`), from the binding names
 * core gave the build (`workflowBindingsPath`): none when core gave none,
 * so `env` takes any name; a failure when what it gave isn't binding
 * names, which is core's fault, never the App's.
 */
const workflowEnvOf = (
  files: Readonly<Record<string, string>>
): { files: Record<string, string> } | { errors: Diagnostic[] } => {
  if (!Object.hasOwn(files, workflowBindingsPath)) {
    return { files: {} };
  }
  let data: unknown;
  try {
    data = JSON.parse(files[workflowBindingsPath] ?? "");
  } catch {
    data = undefined;
  }
  const bindings = workflowBindingsSchema.safeParse(data);
  return bindings.success
    ? { files: { [workflowEnvPath]: workflowEnvDeclaration(bindings.data) } }
    : {
        errors: [
          problem(
            "build",
            "The workflows' binding names the build was given aren't binding names.",
            { file: workflowBindingsPath }
          ),
        ],
      };
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
): Unchecked<WorkflowBuild> => {
  const read = workflowFiles(files);
  // The bindings' declaration is only ever the compiler's own
  // (`workflowEnvOf`), never a file it was given at its path.
  const { [workflowEnvPath]: _given, ...context } = workflowTypeContext(files);
  const tooMuch = appCodeLimitErrors({ ...context, ...read });
  if (tooMuch.length > 0) {
    return { built: { ok: false, diagnostics: tooMuch } };
  }
  const strays = strayProblems(read, [workflowsFolder], "workflows");
  if (strays.length > 0) {
    return { built: { ok: false, diagnostics: strays } };
  }
  // Only workflow code is compiled or checked, whatever else is passed:
  // what isn't is refused above, and kept out should that ever miss it.
  const workflows = Object.fromEntries(
    Object.entries(read).filter(([path]) => workflowsFolder.isFile(path))
  );
  const built = compileCode(
    workflowCode,
    workflows,
    new Set(Object.keys({ ...context, ...read }))
  );
  if (!built.ok) {
    return { built };
  }
  // The App's server code joins the check only as it builds (what server
  // code may import and name, no directive, suppression or ambient
  // module), so none of it can steer the workflows' check; its own type
  // errors are its seal's (`checkAppCode`), never a workflow's. Server
  // code that doesn't build stays out, and a workflow that names it is
  // told why its types are missing.
  const layout = isAppLayout(context);
  const serverBuilds = layout && buildAppCode(context).ok;
  const env = workflowEnvOf(files);
  if ("errors" in env) {
    return { built: { ok: false, diagnostics: env.errors } };
  }
  const checked = serverBuilds
    ? { ...context, ...workflows, ...env.files }
    : { ...workflows, ...env.files };
  return {
    built,
    typeCheck: {
      request: typeCheckRequest(checked, workflowTarget),
      reported: Object.keys(workflows),
      lenient: readsStandIns(checked) ? callbackParameters(workflows) : [],
      ...(layout && !serverBuilds
        ? {
            failing: {
              rule: "server",
              severity: "warning",
              message:
                "The App's server code doesn't build, so its types aren't in this check: a workflow that names them (appFunctions<Tree>(env), import type from server/) can't find them until it builds.",
            },
          }
        : {}),
    },
  };
};

/**
 * Builds an App's tests (`tests/**`), each held to what a test may import
 * (app-code.ts): only the test files become modules. The schema and
 * values they import, and the `@server/_generated/api` references, are the release's own
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
  // The entry the host runs the App from, made from its file list: its
  // registration with every server module's functions. Built as the
  // host's own code, never type-checked as the App's.
  code[serverEntryPath] = serverEntrySource(Object.keys(code));
  const known = new Set(Object.keys(code));
  const modules: Record<string, string> = {};
  const errors: Diagnostic[] = [];
  for (const [path, source] of Object.entries(code)) {
    if (appCodeKind(path) === "test") {
      const result = compileAppCodeFile(
        path,
        source,
        known,
        new Set(),
        new Set(Object.keys(files))
      );
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
 * An App's server code of spec 8's layout built (`buildAppCode`) and
 * type-checked against the SDK's server side, with the host's generated
 * modules (`.grasp/`) among its files: what it would build to, or why it
 * fails, its type errors included. No DOM: its isolate has none. A seal
 * holds its release to this before anything is sealed (app-releases.ts);
 * a build alone, as the seal's first, symbolic inspection makes it,
 * doesn't, since its generated modules are stand-ins without types.
 */
export const checkAppCode = async (
  files: Record<string, string>
): Promise<Unchecked<AppCodeBuild>> => {
  const tooMuch = appCodeLimitErrors(appCodeFiles(files));
  if (tooMuch.length > 0) {
    return { built: { ok: false, diagnostics: tooMuch } };
  }
  // The type check runs whatever the build found, so one check names
  // everything there is to fix (`together`).
  const unparsed = new Set<string>();
  const built = buildAppCodeNoting(files, unparsed);
  // Its tests, checked in the same program: their `@server/_generated/api` is the
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
  const checked = { ...appCodeFiles(files), ...tests };
  // Its lint's parser (`lintServerCode`).
  await startOxcParser(oxcParserWasm);
  return {
    built,
    typeCheck: {
      request: typeCheckRequest(checked, appCodeTarget),
      found: built.ok ? [] : built.diagnostics,
      after: lintServerCode(appCodeFiles(files)),
      unparsed: [...unparsed],
      // A draft whose server code doesn't register is checked against the
      // stand-ins (core's save-builds.ts).
      lenient: readsStandIns(checked) ? callbackParameters(checked) : [],
    },
  };
};

/**
 * What the compiler builds: an App's screens, its server code of spec
 * 8's layout (`app`), its tests, its workflows, a
 * JSON workflow's generated module and its compute modules.
 */
export type CompileTarget =
  | "screens"
  | "preview-screens"
  | "preview-frame"
  | "app"
  | "app-tests"
  | "workflows"
  | "open-workflow"
  | "compute";

/** What a build of each target answers, once its type check is in (`Unchecked`). */
export interface TargetBuilds {
  screens: ScreenBuild;
  "preview-screens": ScreenBuild;
  "preview-frame": ScreenBuild;
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
  ) =>
    | Unchecked<TargetBuilds[Target]>
    | Promise<Unchecked<TargetBuilds[Target]>>;
} = {
  screens: async (files) => await buildScreens(files),
  // A chat's draft (spec 19.2.1): every gate of `screens`, instrumented
  // for React Fast Refresh, on the preview kit.
  "preview-screens": async (files) =>
    await buildScreens(files, { preview: true }),
  // What a preview's frame runs, and each of its updates: built as
  // `preview-screens` is, without the type check and lint that would
  // hold it up (`buildScreensIncrementally`).
  "preview-frame": async (files) =>
    await buildScreens(files, { preview: true, checks: false }),
  app: checkAppCode,
  "app-tests": (files) => ({ built: buildAppTests(files) }),
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

/** The targets built reusing earlier builds' parts, and how each builds. */
const incrementalTargets = {
  screens: { preview: false, checks: true },
  "preview-screens": { preview: true, checks: true },
  "preview-frame": { preview: true, checks: false },
} as const;

/** What `buildIncrementally` builds. */
export type IncrementalTarget = keyof typeof incrementalTargets;

/**
 * What core handed over of earlier builds, as records by key: anything
 * else is nothing. Each record is checked again where it is used.
 */
const incrementsOf = (value: unknown): Handed => {
  const records = (field: string): Record<string, unknown> => {
    const found: unknown =
      typeof value === "object" && value !== null && Object.hasOwn(value, field)
        ? Reflect.get(value, field)
        : undefined;
    return typeof found === "object" && found !== null && !Array.isArray(found)
      ? Object.fromEntries(Object.entries(found))
      : {};
  };
  return { modules: records("modules") };
};

/**
 * The App compiler, in an isolate of its own: it parses, checks and
 * transforms App code, and never runs it. Each method takes the target it
 * acts on, and nothing else is exposed.
 */
export default class AppCompiler extends WorkerEntrypoint {
  /**
   * Builds `target` from `files`, with every gate the target has (lint,
   * import boundaries, limits): its output, or why it fails; and the type
   * check it waits on, which core runs in the checker's isolate and puts
   * together with it (checked-build.ts `withTypeCheck`).
   */
  // RPC exposes prototype methods only, so these can't be static.
  async build<Target extends CompileTarget>(
    target: Target,
    files: Record<string, string>
  ): Promise<Unchecked<TargetBuilds[Target]>> {
    assertNoBindings(this.env, this.ctx.props, "The App compiler");
    const known = knownTarget(targetBuilds, target, "build");
    // SAFETY: `known` is `target`, which picks its own builder.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return (await targetBuilds[known](files)) as Unchecked<
      TargetBuilds[Target]
    >;
  }

  /**
   * Builds the screens (`target`: `screens`, or a preview's) from `files`
   * as `build` does, every gate the same, reusing what earlier builds
   * kept (`reuse`, increments.ts) where its key says it is what this
   * build would make; with what it makes now, for core to keep, and how
   * much it reused.
   */
  async buildIncrementally(
    target: IncrementalTarget,
    files: Record<string, string>,
    reuse: unknown
  ): Promise<IncrementalBuild<Unchecked<ScreenBuild>>> {
    assertNoBindings(this.env, this.ctx.props, "The App compiler");
    const known = knownTarget(incrementalTargets, target, "buildIncrementally");
    return await buildScreensIncrementally(files, {
      ...incrementalTargets[known],
      reuse: incrementsOf(reuse),
    });
  }

  /**
   * Transforms part of a screens build's sources (`target`: `screens`, or
   * a preview's) as `buildIncrementally` would (`transformScreens`): the
   * records it makes, by key, for core to keep and the build to reuse.
   */
  async transform(
    target: IncrementalTarget,
    batch: Record<string, string>,
    paths: { known: string[]; typeFiles: string[] }
  ): Promise<Record<string, ModuleRecord>> {
    assertNoBindings(this.env, this.ctx.props, "The App compiler");
    const known = knownTarget(incrementalTargets, target, "transform");
    return await transformScreens(
      batch,
      paths,
      incrementalTargets[known].preview
    );
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
