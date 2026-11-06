/**
 * The App compiler, as it runs in its own isolate (a Dynamic Worker, one
 * per build). It has no bindings and no network: it reads the files it is
 * given and what it knows of the kit, nothing else.
 *
 * Each App file becomes one ES module: oxc runs the React Compiler,
 * strips types and turns JSX into calls (oxc.wasm, compile.ts), then its
 * imports are pointed at flat module names (imports.ts, kit.ts). There is
 * no bundler: the kit's modules are built once per release and shared by
 * every App, and a build says which of them, and which of the App's own,
 * each page loads. The App is type-checked, and its classes checked
 * against the kit's design system (classes.ts), whatever the compile
 * found, so a build names everything there is to fix at once (its lint is
 * a check of its own: ultracite.ts); once it all passes, Tailwind compiles
 * the CSS for the classes in the App's sources and in the kit modules it
 * loads.
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
  serverCodeFolders,
  serverEntryPath,
  serverEntrySource,
  strayTestFileMessage,
  strayTestFiles,
  typeImportError,
} from "./app-code.ts";
import { assertNoBindings } from "./authority.ts";
import { extractCandidates } from "./candidates.ts";
import type { TypeCheckPlan, Unchecked } from "./checked-build.ts";
import { classProblems, classSitesOf } from "./classes.ts";
import type { ClassSite } from "./classes.ts";
import { compileReact, refreshNames, stripTypes } from "./compile.ts";
import { isError } from "./diagnostic.ts";
import type { Diagnostic } from "./diagnostic.ts";
import {
  declarationValueImportError,
  importError,
  codeImportError,
  typeFileError,
  rewriteAppCodeImports,
  rewriteCodeImports,
  computeCodeWith,
  generatedWorkflowCode,
  rewriteImports,
  pageTypeImportError,
  importSitesOf,
} from "./imports.ts";
import type { CodeKind, ImportSite, ModuleImports } from "./imports.ts";
import {
  moduleKey,
  moduleRecordOf,
  noIncrements,
  pageSources,
} from "./increments.ts";
import type {
  BuildMetrics,
  Handed,
  IncrementalBuild,
  ModuleRecord,
} from "./increments.ts";
import { apiCallsOf, indexReadsOf } from "./index-uses.ts";
import type { IndexRead } from "./index-uses.ts";
import {
  appCodeLimitErrors,
  buildFiles,
  declarationFile,
  limitErrors,
  computeModuleErrors,
  generatedWorkflowErrors,
  isDesignLinted,
  routeTreePath,
} from "./inputs.ts";
import {
  appModuleName,
  computePackagesFile,
  kitModuleName,
  kitStylesheet,
  ownEntry,
  previewRefresh,
  previewRuntime,
  pageReferences,
  pageRuntime,
} from "./kit.ts";
import { addressModules } from "./module-addresses.ts";
import { startOxc } from "./oxc.ts";
import type { Transformed } from "./oxc.ts";
import oxcWasm from "./oxc.wasm";
import { problem, pageRefusals, strayProblems } from "./refusals.ts";
import type { Location } from "./refusals.ts";
import { routeTree } from "./route-tree.ts";
import type { SurfaceManifest } from "./route-tree.ts";
import { callbackParameters, readsStandIns } from "./stand-ins.ts";
import { directivesIn, referenceError } from "./steering.ts";
import type { DirectiveSite } from "./steering.ts";
import { parsed } from "./syntax.ts";
import {
  appCodeTarget,
  computeTarget,
  pageTarget,
  typeCheckRequest,
} from "./type-check.ts";

// oxc's parser and transform, started once per isolate: oxc.wasm is
// compiled as the isolate loads, and an instance kept for every build.
startOxc(oxcWasm);

/**
 * What a frame loads to run an App's pages, by flat name: of the App's
 * modules, the route tree's and what it imports, directly or through
 * others; of the kit's, what those import, and the page runtime.
 */
export interface PageClosure {
  modules: string[];
  kitModules: string[];
}

/**
 * An App's modules by flat name, what its pages load of them and of the
 * kit's from their route tree's module, the surfaces they declare and the
 * CSS they use; or why it failed. Errors fail a build; warnings don't.
 */
export type PageBuild =
  | {
      ok: true;
      /** Each importing the others by address (module-addresses.ts). */
      modules: Record<string, string>;
      /** Each module's address, by flat name: where a frame loads it. */
      addresses: Record<string, string>;
      /** The route tree's module, which the frame's runtime routes by. */
      entry: string;
      /** What the frame loads, from `entry`. */
      closure: PageClosure;
      surfaces: SurfaceManifest[];
      css: string;
      /** The App's functions each page file calls, by its path (index-uses.ts). */
      calls: Record<string, string[]>;
      diagnostics: Diagnostic[];
    }
  | {
      ok: false;
      diagnostics: Diagnostic[];
      /** What each page file that compiled as far as its parse calls. */
      calls?: Record<string, string[]>;
    };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A compile error's message, in words for whoever fixes the file. */
const compileMessage = (message: string): string =>
  message.includes("Handle Import expressions")
    ? "import() can't be used inside a component or hook: import the module at the top of the file."
    : message;

/**
 * Why `transformed` (`file`) failed, each error where it is: a syntax
 * error, or what the React Compiler refuses, with how to fix it when it
 * says. A file that doesn't parse is added to `unparsed`.
 */
const transformErrors = (
  file: string,
  transformed: Transformed,
  unparsed: Set<string>
): Diagnostic[] => {
  if (!transformed.parsed) {
    unparsed.add(file);
  }
  return transformed.errors.map(({ message, help, line, column }) => ({
    ...problem("compile", compileMessage(message), {
      file,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
    }),
    ...(help === undefined ? {} : { fix: help }),
  }));
};

/** What `transformed` names of modules, and its directives to the type check. */
const sitesOf = (
  transformed: Transformed
): { imports: ImportSite[]; directives: DirectiveSite[] } => ({
  imports: importSitesOf(transformed),
  directives: directivesIn(transformed.comments),
});

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
 * What a page's or a declaration's triple-slash directives reach beyond
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
):
  | {
      code: string;
      imported: ModuleImports;
      calls: string[];
      classes: ClassSite[];
    }
  | { errors: Diagnostic[]; calls: string[] } => {
  const transformed = compileReact(path, source, { refresh });
  // What it calls and the classes it writes, read from its syntax tree:
  // what it calls is read even when it doesn't compile, as far as it
  // parses.
  const tree = transformed.parsed ? parsed(path, source) : undefined;
  const calls = apiCallsOf(tree);
  if (transformed.code === null) {
    return { errors: transformErrors(path, transformed, unparsed), calls };
  }
  const { imports, directives } = sitesOf(transformed);
  const errors = referenceErrors(path, directives, typeFiles);
  const declarations = new Set(
    [...typeFiles].filter((typeFile) => declarationFile.test(typeFile))
  );
  for (const site of imports) {
    // A type may also name the App's declarations (`typeFiles`); a value
    // never does, as they compile to nothing.
    const message = site.typeOnly
      ? pageTypeImportError(site, path, typeFiles, kit)
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
    return { errors, calls };
  }
  const imported: ModuleImports = { app: new Set(), kit: new Set() };
  try {
    const code = rewriteImports(transformed.code, path, files, kit, imported);
    const classes = isDesignLinted(path) ? classSitesOf(tree) : [];
    if (!refresh) {
      return { code, imported, calls, classes };
    }
    imported.kit.add(kitModuleName(previewRefresh));
    return {
      code: `${refreshHeader(path)}${code}`,
      imported,
      calls,
      classes,
    };
  } catch (error) {
    // An import only the compiled code makes, refused: its JSX runtime.
    untyped.add(path);
    return {
      errors: [problem("imports", messageOf(error), { file: path })],
      calls,
    };
  }
};

/**
 * Why an App's declaration file (`*.d.ts`) can't import what it does:
 * all it imports is types, held to what a page's types may name
 * (`pageTypeImportError`) among `typeFiles`.
 */
const declarationImportErrors = (
  path: string,
  source: string,
  typeFiles: ReadonlySet<string>,
  unparsed: Set<string>
): Diagnostic[] => {
  const transformed = stripTypes(path, source);
  if (transformed.code === null) {
    return transformErrors(path, transformed, unparsed);
  }
  const { imports, directives } = sitesOf(transformed);
  return [
    ...referenceErrors(path, directives, typeFiles),
    ...imports.flatMap((site) => {
      const { line } = site;
      const message = pageTypeImportError(site, path, typeFiles, kit);
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
 * The transform of the page source `path`, as a build keeps it, or why
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
): { record: ModuleRecord } | { errors: Diagnostic[]; calls: string[] } => {
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
      // The references' and the route tree's classes are the host's.
      candidates:
        path === pageReferences.path || path === routeTreePath
          ? []
          : extractCandidates(source),
      calls: result.calls,
      classes: result.classes,
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
 * runtime renders the pages: a page needs it for any of them.
 */
const kitModulesFor = (
  imported: Iterable<string>,
  preview = false
): string[] =>
  preview
    ? closureOf(
        // The preview runtime loads the page runtime by name, once
        // React Fast Refresh is in (sdk/src/preview-runtime.ts).
        [
          ...imported,
          kitModuleName(previewRuntime),
          kitModuleName(pageRuntime),
        ],
        (name) => ownEntry(kit.previewModuleImports, name) ?? []
      )
    : closureOf(
        [...imported, kitModuleName(pageRuntime)],
        (name) => ownEntry(kit.moduleImports, name) ?? []
      );

/**
 * What a frame loads from the module `entry`, the route tree, given what
 * each of the App's modules imports: what nothing a page reaches uses,
 * of the App's or the kit's, stays out.
 */
const pageClosure = (
  entry: string,
  imports: ReadonlyMap<string, ModuleImports>,
  preview = false
): PageClosure => {
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
 * What a page's type check resolves an App file's imports to by name:
 * the kit's modules, its icons, the JSX runtime the compile names, and
 * the database's types the data model names (`pageDataModel`). Nothing
 * else of the kit, however a file names it (type-check.ts); a page's own
 * import of the database's types is refused at its compile (imports.ts).
 */
const pagesTarget = pageTarget(
  new Set([
    ...kit.imports,
    "lucide-react",
    "react/jsx-runtime",
    "@grasp-os/sdk/database",
  ])
);

/** `record`'s own entry for `key`, never one it inherits. */
const ownRecord = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/**
 * The type check of the App's pages against the kit's types, which core
 * runs in the checker's isolate (checked-build.ts): `buildPages`' last
 * gate, beside its compile and import checks.
 */
const pagesCheck = (
  app: Record<string, string>,
  {
    found,
    unparsed,
    untyped,
  }: {
    found: Diagnostic[];
    unparsed: ReadonlySet<string>;
    untyped: ReadonlySet<string>;
  }
): TypeCheckPlan => ({
  request: typeCheckRequest(app, pagesTarget),
  found,
  unparsed: [...unparsed],
  untyped: [...untyped],
  lenient: readsStandIns(app) ? callbackParameters(app) : [],
  carries: true,
});

/**
 * Builds an App's pages: its file routes under `src/routes/`, the rest
 * of `src/` they use, and the declarations (`*.d.ts`) at the App's root
 * and under `src/`, which are types alone and never modules. Their route
 * tree is TanStack's generator's (route-tree.ts), made afresh by every
 * build: one file, and what the frame's runtime routes by.
 *
 * With `preview`, for a chat's draft (spec 19.2.1): each module is
 * instrumented for React Fast Refresh, and what a page loads of the kit
 * is the preview kit's. Every gate is the same.
 *
 * Without `checks`, for a preview's frame only (`preview-frame`), the
 * type check and the class checks don't run: they hold up nothing the
 * frame needs, and the agent hears them from its own check of the draft
 * (`preview-pages`, which has them). Neither is a boundary: what a
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
export const buildPagesIncrementally = async (
  files: Record<string, string>,
  {
    preview = false,
    checks = true,
    reuse = noIncrements(),
  }: { preview?: boolean; checks?: boolean; reuse?: Handed } = {}
): Promise<IncrementalBuild<Unchecked<PageBuild>>> => {
  const fresh = noIncrements();
  const metrics: BuildMetrics = { compiled: 0, reused: 0 };
  const done = (
    built: PageBuild,
    typeCheck?: TypeCheckPlan
  ): IncrementalBuild<Unchecked<PageBuild>> => ({
    built: typeCheck === undefined ? { built } : { built, typeCheck },
    fresh,
    metrics,
  });
  const app = buildFiles(files);
  const tooMuch = appCodeLimitErrors(app);
  if (tooMuch.length > 0) {
    return done({ ok: false, diagnostics: tooMuch });
  }
  const refused = pageRefusals(app);
  if (refused.length > 0) {
    return done({ ok: false, diagnostics: refused });
  }
  // The pages as the generator left them (`RouteTree.routes`): what the
  // tree routes is what compiles. Each is kept under the key of the file
  // as written (`moduleKey`): the generator's correction is a function of
  // the file's path and source, so the file pins down what compiles, as
  // core works the keys out (`pageIncrementKeys`).
  const tree = await routeTree(app);
  const routed = { ...app, ...tree.routes };
  // Only pages, components and the references they import are
  // compiled, whatever else is passed: what isn't is refused above, and
  // kept out should that ever miss it. Declarations are only types.
  const { sources, known: paths, typeFiles: typed } = pageSources(app);
  const known = new Set(paths);
  // What a type may name: the build's files and its declarations.
  const typeFiles = new Set(typed);
  const modules: Record<string, string> = {};
  const imports = new Map<string, ModuleImports>();
  const candidates: string[] = [];
  const calls: Record<string, string[]> = {};
  const records: ModuleRecord[] = [];
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
    if (record.calls.length > 0) {
      calls[record.path] = record.calls;
    }
    records.push(record);
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
      routed[path] ?? source,
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
      // What it calls is read all the same: the parse got that far.
      if (result.calls.length > 0) {
        calls[path] = result.calls;
      }
    }
  }
  // The route tree, compiled afresh: it changes with the pages' paths,
  // never on its own, and takes a moment to compile. What is wrong with
  // it fails the build beside what the files' own checks find.
  errors.push(...tree.diagnostics);
  if (tree.source !== undefined) {
    const compiledTree = transformSource(
      routeTreePath,
      tree.source,
      { known: new Set([...known, routeTreePath]), typeFiles },
      { unparsed, untyped },
      preview
    );
    if ("record" in compiledTree) {
      take(compiledTree.record);
    } else {
      errors.push(...compiledTree.errors);
    }
  }
  // The design system's checks of every class the pages write, beside
  // the type check, which a preview's frame skips too (`checks`).
  if (checks) {
    for (const record of records) {
      // oxlint-disable-next-line no-await-in-loop -- the design system loads once, then each is quick
      errors.push(...(await classProblems(record.path, record.classes)));
    }
  }
  // The App's declarations aren't modules, but they name modules for
  // their types: held to what a page must never reach, as a page's
  // own types are.
  for (const [path, source] of Object.entries(routed)) {
    if (declarationFile.test(path)) {
      errors.push(
        ...declarationImportErrors(path, source, typeFiles, unparsed)
      );
    }
  }
  // The type check runs whatever the compile found, so one build names
  // everything there is to fix; only what says a compile error again is
  // left out (`together`). A preview's frame skips it (`checks`): its
  // compile errors still fail it.
  const typeCheck = checks
    ? pagesCheck(
        tree.source === undefined
          ? routed
          : { ...routed, [routeTreePath]: tree.source },
        { found: errors, unparsed, untyped }
      )
    : undefined;
  if (errors.some((diagnostic) => isError(diagnostic))) {
    return done({ ok: false, diagnostics: errors, calls }, typeCheck);
  }
  const kitModules = kitModulesFor(
    [...imports.values()].flatMap(({ kit: imported }) => [...imported])
  );
  const css = await buildCss(candidates, kitModules);
  const entry = appModuleName(routeTreePath);
  return done(
    {
      ok: true,
      ...(await addressModules(modules)),
      entry,
      closure: pageClosure(entry, imports, preview),
      surfaces: tree.surfaces,
      css,
      calls,
      diagnostics: errors,
    },
    typeCheck
  );
};

/** Builds an App's pages with nothing reused (`buildPagesIncrementally`). */
export const buildPages = async (
  files: Record<string, string>,
  {
    preview = false,
    checks = true,
  }: { preview?: boolean; checks?: boolean } = {}
): Promise<Unchecked<PageBuild>> => {
  const { built } = await buildPagesIncrementally(files, { preview, checks });
  return built;
};

/** Compiles one file of code that runs outside the pages, or says why it can't be. */
const compileCodeFile = (
  kind: CodeKind,
  path: string,
  source: string,
  files: ReadonlySet<string>,
  typeFiles: ReadonlySet<string>
): { code: string } | { errors: Diagnostic[] } => {
  const transformed = stripTypes(path, source);
  if (transformed.code === null) {
    return { errors: transformErrors(path, transformed, new Set()) };
  }
  const compiled = transformed.code;
  const { imports, directives } = sitesOf(transformed);
  // What would steer the type check of code whose types are checked
  // (`buildComputeModules`) rather than be checked by it: a triple-slash
  // directive reaches the whole program (a module's
  // `/// <reference lib="dom" />` would give every module the DOM), and
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
    return { code: rewriteCodeImports(compiled, kind, path, files) };
  } catch (error) {
    return {
      errors: [problem("imports", messageOf(error), { file: path })],
    };
  }
};

/** Code compiled file by file, as modules by flat name; or why it failed. */
type CodeBuild =
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
): CodeBuild => {
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
export type GeneratedWorkflowBuild =
  | { ok: true; modules: Record<string, string> }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Builds the module the host generated from a JSON workflow
 * (`generatedWorkflowEntry`): type-checked against the SDK's own declarations,
 * then compiled, importing only `@grasp-os/sdk/workflow`
 * (`generatedWorkflowCode`). It is the host's own output, so a type error
 * is the generator's, and nothing is sealed that doesn't check.
 */
export const buildGeneratedWorkflow = (
  files: Record<string, string>
): Unchecked<GeneratedWorkflowBuild> => {
  const wrong = generatedWorkflowErrors(files);
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
 * Builds a JSON workflow's compute modules (`code/<file>.ts`): compiled
 * file by file, importing only each other, the compute SDK and
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
  | {
      ok: true;
      modules: Record<string, string>;
      /** The indexes its functions read (index-uses.ts). */
      indexReads?: IndexRead[];
    }
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
  typeFiles: ReadonlySet<string> = files,
  /** Where the indexes its functions read are listed. */
  reads: IndexRead[] = []
): { code: string } | { errors: Diagnostic[] } => {
  // With its source map, so a stack trace of the module is read back to
  // the line of the file to fix (core's app-inspection.ts).
  const transformed = stripTypes(path, source, { sourceMap: true });
  if (transformed.code === null) {
    return { errors: transformErrors(path, transformed, unparsed) };
  }
  reads.push(...indexReadsOf(path, parsed(path, source)));
  const { code: compiled, map } = transformed;
  const { imports, directives } = sitesOf(transformed);
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
    // Pointing imports elsewhere changes no line, so the map holds.
    const code = rewriteAppCodeImports(compiled, path, files);
    return {
      code: map === undefined ? code : `${code}\n//# sourceMappingURL=${map}\n`,
    };
  } catch (error) {
    return {
      errors: [problem("imports", messageOf(error), { file: path })],
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
          "The App has no grasp.config.ts and server/schema.ts, which Grasp generates from its definition.json."
        ),
      ],
    };
  }
  // The entry the host runs the App from, made from its file list: its
  // config and schema with every server module's functions and
  // every migration. Built as the
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
  const indexReads: IndexRead[] = [];
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
    const result = compileAppCodeFile(
      path,
      source,
      known,
      unparsed,
      known,
      indexReads
    );
    if ("code" in result) {
      modules[name] = result.code;
    } else {
      errors.push(...result.errors);
    }
  }
  return errors.length > 0
    ? { ok: false, diagnostics: errors }
    : { ok: true, modules, indexReads };
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
  // config and schema with every server module's functions and
  // every migration. Built as the
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
export const checkAppCode = (
  files: Record<string, string>
): Unchecked<AppCodeBuild> => {
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
  return {
    built,
    typeCheck: {
      request: typeCheckRequest(checked, appCodeTarget),
      found: built.ok ? [] : built.diagnostics,
      unparsed: [...unparsed],
      // A draft whose server code doesn't register is checked against the
      // stand-ins (core's save-builds.ts).
      lenient: readsStandIns(checked) ? callbackParameters(checked) : [],
    },
  };
};

/**
 * What the compiler builds: an App's pages, its server code of spec
 * 8's layout (`app`), its tests, a JSON workflow's generated module and
 * its compute modules.
 */
export type CompileTarget =
  | "pages"
  | "preview-pages"
  | "preview-frame"
  | "app"
  | "app-tests"
  | "generated-workflow"
  | "compute";

/** What a build of each target answers, once its type check is in (`Unchecked`). */
export interface TargetBuilds {
  pages: PageBuild;
  "preview-pages": PageBuild;
  "preview-frame": PageBuild;
  app: AppCodeBuild;
  "app-tests": AppCodeBuild;
  "generated-workflow": GeneratedWorkflowBuild;
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
  pages: async (files) => await buildPages(files),
  // A chat's draft (spec 19.2.1): every gate of `pages`, instrumented
  // for React Fast Refresh, on the preview kit.
  "preview-pages": async (files) => await buildPages(files, { preview: true }),
  // What a preview's frame runs, and each of its updates: built as
  // `preview-pages` is, without the type check and lint that would
  // hold it up (`buildPagesIncrementally`).
  "preview-frame": async (files) =>
    await buildPages(files, { preview: true, checks: false }),
  app: checkAppCode,
  "app-tests": (files) => ({ built: buildAppTests(files) }),
  "generated-workflow": buildGeneratedWorkflow,
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
  pages: { preview: false, checks: true },
  "preview-pages": { preview: true, checks: true },
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
   * Builds the pages (`target`: `pages`, or a preview's) from `files`
   * as `build` does, every gate the same, reusing what earlier builds
   * kept (`reuse`, increments.ts) where its key says it is what this
   * build would make; with what it makes now, for core to keep, and how
   * much it reused.
   */
  async buildIncrementally(
    target: IncrementalTarget,
    files: Record<string, string>,
    reuse: unknown
  ): Promise<IncrementalBuild<Unchecked<PageBuild>>> {
    assertNoBindings(this.env, this.ctx.props, "The App compiler");
    const known = knownTarget(incrementalTargets, target, "buildIncrementally");
    return await buildPagesIncrementally(files, {
      ...incrementalTargets[known],
      reuse: incrementsOf(reuse),
    });
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
