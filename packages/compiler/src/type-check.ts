/**
 * Type-checks App files with TypeScript 6, the last TypeScript with a
 * JavaScript API, against the kit's declarations. Everything is in memory:
 * App files at `/<path>`, the kit's packages at `/node_modules/<name>/…`,
 * as `build.ts` collected them (`Kit.types`).
 */
import ts from "typescript";

import type { Diagnostic } from "./diagnostic.ts";
import { ownEntry, screenReferences } from "./kit.ts";

/**
 * How App code is checked. `build.ts` loads the kit with the same options
 * to collect the files a check reads, so both must agree.
 */
export const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  // `Symbol.dispose`: Cap'n Web's callbacks and stubs, which screens pass
  // to and get from their server, are disposable.
  lib: ["lib.es2024.d.ts", "lib.dom.d.ts", "lib.esnext.disposable.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  // Babel compiles each file on its own.
  isolatedModules: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  // Off, so the App's own declaration files are checked. Only App files'
  // diagnostics are asked for, so the kit's declarations aren't checked.
  skipLibCheck: false,
  types: [],
  // The App's generated references, as its screens import them.
  paths: { [screenReferences.specifier]: [`./${screenReferences.path}`] },
};

/** Where TypeScript's own declarations (`lib.dom.d.ts`, …) are. */
export const libLocation = "/node_modules/typescript/lib";

const trailingSlashes = /\/+$/u;

/** Every directory that holds one of these files. */
const directoriesOf = (paths: Iterable<string>): Set<string> => {
  const directories = new Set<string>(["/"]);
  for (const path of paths) {
    for (
      let end = path.lastIndexOf("/");
      end > 0;
      end = path.lastIndexOf("/", end - 1)
    ) {
      directories.add(path.slice(0, end));
    }
  }
  return directories;
};

/**
 * The kit's files and what TypeScript made of them, once per isolate:
 * parsing the kit's declarations is most of a check's work.
 */
let kitCache:
  | {
      files: Record<string, string>;
      directories: Set<string>;
      parsed: Map<string, ts.SourceFile>;
      /**
       * How the kit's own files' imports resolve: kit files only, under
       * `/node_modules`, where no App file is, so the same for every App
       * and kept for the isolate. Only imports made by a kit file are
       * resolved through it; an App file's go through a cache of its own
       * check, never kept.
       */
      resolutions: ts.ModuleResolutionCache;
    }
  | undefined;

/** A resolution cache, of paths as they are: the file system is in memory. */
const resolutionCache = (): ts.ModuleResolutionCache =>
  ts.createModuleResolutionCache("/", (path) => path, compilerOptions);

const kitOf = (files: Record<string, string>) => {
  if (kitCache?.files !== files) {
    kitCache = {
      files,
      directories: directoriesOf(Object.keys(files)),
      parsed: new Map(),
      resolutions: resolutionCache(),
    };
  }
  return kitCache;
};

/** Where the kit's packages are: no App file is under it. */
const kitRoot = "/node_modules/";

const severities: Partial<
  Record<ts.DiagnosticCategory, Diagnostic["severity"]>
> = {
  [ts.DiagnosticCategory.Error]: "error",
  [ts.DiagnosticCategory.Warning]: "warning",
};

const toDiagnostic = (diagnostic: ts.Diagnostic): Diagnostic | undefined => {
  const severity = severities[diagnostic.category];
  if (severity === undefined) {
    return undefined;
  }
  const result: Diagnostic = {
    rule: `TS${diagnostic.code}`,
    severity,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  };
  const { file, start } = diagnostic;
  if (file !== undefined) {
    result.file = file.fileName.slice(1);
    if (start !== undefined) {
      const { line, character } = file.getLineAndCharacterOfPosition(start);
      result.line = line + 1;
      result.column = character + 1;
    }
  }
  return result;
};

/**
 * Whether an App file's import of `name` may resolve where it did: to
 * one of the App's files by a relative path or by the `#grasp` mapping,
 * or by name to one of the modules `allowed` lists. Whatever the syntax
 * that names it (an ambient module's import, a re-export, a pragma), an
 * App file reaches nothing else of the kit: not its packages' own files
 * by path, not a module the kit holds but doesn't give the App. The
 * kit's own files resolve as TypeScript does.
 */
const resolvesWithin = (
  name: string,
  resolved: ts.ResolvedModuleFull | undefined,
  app: ReadonlyMap<string, string>,
  allowed: ReadonlySet<string>
): boolean => {
  if (resolved === undefined) {
    return false;
  }
  if (app.has(resolved.resolvedFileName)) {
    return (
      name.startsWith("./") ||
      name.startsWith("../") ||
      name === screenReferences.specifier
    );
  }
  return allowed.has(name);
};

/** Where `/// <reference path>` in `file` points: a path from the App's root. */
const referencedPath = (file: string, reference: string): string => {
  const parts = reference.startsWith("/") ? [] : file.split("/").slice(0, -1);
  for (const part of reference.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part !== "." && part !== "") {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
};

/**
 * What an App file's triple-slash directives reach beyond its own files:
 * a `/// <reference path>` only to another App file, never into the kit's
 * node_modules, and no `/// <reference types>` at all. The import checks
 * hold every import an App file writes; these are how it would name a
 * module without one.
 */
const referenceErrors = (
  file: ts.SourceFile,
  app: ReadonlyMap<string, string>
): Diagnostic[] => {
  const at = (position: number) => {
    const { line, character } = file.getLineAndCharacterOfPosition(position);
    return { line: line + 1, column: character + 1 };
  };
  return [
    ...file.referencedFiles
      .filter(
        ({ fileName }) => !app.has(referencedPath(file.fileName, fileName))
      )
      .map(({ fileName, pos }) => ({
        rule: "imports",
        severity: "error" as const,
        message: `"${fileName}" is not one of the App's files: a reference path names only those.`,
        file: file.fileName.slice(1),
        ...at(pos),
      })),
    ...file.typeReferenceDirectives.map(({ fileName, pos }) => ({
      rule: "imports",
      severity: "error" as const,
      message: `"${fileName}": App files reference no type packages; import what the kit has instead.`,
      file: file.fileName.slice(1),
      ...at(pos),
    })),
  ];
};

/**
 * Type-checks App files (paths relative to the App, e.g.
 * `screens/desk.tsx`) against the kit and the App's own declaration files
 * among them (e.g. its server's types), which are checked too.
 */
export const typeCheck = (
  appFiles: Record<string, string>,
  kitTypes: Record<string, string>,
  allowed?: ReadonlySet<string>
): Diagnostic[] => {
  const kit = kitOf(kitTypes);
  const app = new Map(
    Object.entries(appFiles).map(([path, source]) => [`/${path}`, source])
  );
  const appDirectories = directoriesOf(app.keys());
  // This check's own: App files' resolutions never outlive it.
  const appResolutions = resolutionCache();
  // The kit's cache holds only the kit's files' resolutions: should any
  // App file sit under the kit's root, this check keeps none of its own.
  const kitShared = ![...app.keys()].some((path) => path.startsWith(kitRoot));
  const readFile = (path: string): string | undefined =>
    app.get(path) ?? ownEntry(kit.files, path);
  const parse = (
    path: string,
    languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions
  ): ts.SourceFile | undefined => {
    const source = readFile(path);
    return source === undefined
      ? undefined
      : ts.createSourceFile(path, source, languageVersion);
  };
  const host: ts.CompilerHost = {
    getSourceFile: (path, languageVersion) => {
      if (app.has(path)) {
        return parse(path, languageVersion);
      }
      const parsed = kit.parsed.get(path) ?? parse(path, languageVersion);
      if (parsed !== undefined) {
        kit.parsed.set(path, parsed);
      }
      return parsed;
    },
    getDefaultLibFileName: (options) =>
      `${libLocation}/${ts.getDefaultLibFileName(options)}`,
    getDefaultLibLocation: () => libLocation,
    writeFile: () => {
      // Nothing is emitted.
    },
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (path) => path,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (path) => readFile(path) !== undefined,
    readFile,
    directoryExists: (path) => {
      const directory = path.replace(trailingSlashes, "") || "/";
      return kit.directories.has(directory) || appDirectories.has(directory);
    },
    getDirectories: () => [],
    ...(allowed === undefined
      ? {}
      : {
          resolveModuleNameLiterals: (
            literals,
            containingFile,
            redirectedReference,
            options
          ) =>
            literals.map(({ text }) => {
              const fromKit =
                containingFile.startsWith(kitRoot) && !app.has(containingFile);
              const { resolvedModule } = ts.resolveModuleName(
                text,
                containingFile,
                options,
                host,
                fromKit && kitShared ? kit.resolutions : appResolutions,
                redirectedReference
              );
              return {
                resolvedModule:
                  fromKit || resolvesWithin(text, resolvedModule, app, allowed)
                    ? resolvedModule
                    : undefined,
              };
            }),
        }),
  };
  const program = ts.createProgram([...app.keys()], compilerOptions, host);
  const checked = program
    .getSourceFiles()
    .filter((file) => app.has(file.fileName));
  const references = checked.flatMap((file) => referenceErrors(file, app));
  const found = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...checked.flatMap((file) => [
      ...program.getSyntacticDiagnostics(file),
      ...program.getSemanticDiagnostics(file),
    ]),
  ]
    .map((diagnostic) => toDiagnostic(diagnostic))
    .filter((diagnostic) => diagnostic !== undefined);
  return [...found, ...references];
};
