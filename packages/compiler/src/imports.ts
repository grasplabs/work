import { parse } from "es-module-lexer/js";
import type { Import } from "es-module-lexer/js";

import { appCodeImport, pageImportError, typeImportError } from "./app-code.ts";
import { isTypeOnlyFile, routeTreePath } from "./inputs.ts";
import {
  appModuleName,
  kitModuleName,
  ownEntry,
  packageModuleIn,
  pageDataModel,
  pageReferences,
  pageRootNames,
  routerSpecifier,
  sdkRoot,
} from "./kit.ts";
import type { Kit } from "./kit.ts";
import type { Transformed } from "./oxc.ts";
import { child, children, parsed } from "./syntax.ts";
import type { Node } from "./syntax.ts";

/** An import in a source file, as written. */
export interface ImportSite {
  /** The module it names; undefined for an `import()` of a computed value. */
  specifier: string | undefined;
  line: number | undefined;
  /** The names it imports, or undefined for a default or namespace import. */
  names: string[] | undefined;
  /**
   * Whether it brings in types alone (`import type`, `export type … from`,
   * `typeof import()`), which compiling erases: held only to what the file
   * must never reach (`typeImportError`).
   */
  typeOnly?: true;
  /**
   * Whether it is an ambient module (`declare module "…" { }`), which
   * declares a module by name rather than importing one: what it holds
   * names modules too, and it shadows any module of that name.
   */
  ambient?: true;
}

/**
 * The modules a transformed file's source names (oxc.ts `Transformed`),
 * as written: type-only ones too, which the transform erases but which
 * still name modules, some no file may name.
 */
export const importSitesOf = ({ sites }: Transformed): ImportSite[] =>
  sites.map(({ specifier, line, names, typeOnly, ambient }) => ({
    specifier: specifier ?? undefined,
    line,
    names: names ?? undefined,
    ...(typeOnly === true ? { typeOnly } : {}),
    ...(ambient === true ? { ambient } : {}),
  }));

/** A change to a module's code: `text` in place of `start` to `end`. */
interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * `code`, a module oxc's transform made, with its imports pointed
 * elsewhere, as es-module-lexer finds them: each import's specifier
 * replaced by what `moduleFor` answers for it, which throws for one that
 * isn't allowed, or the whole statement by what `statement` answers, when
 * it answers one. Every specifier goes in quoted (`JSON.stringify`),
 * quotes and all, so nothing a name holds reads as code.
 */
const pointImports = (
  code: string,
  moduleFor: (specifier: string | undefined) => string,
  statement?: (site: Import) => string | undefined
): string => {
  const [imports] = parse(code);
  const edits = imports.flatMap((site): Edit[] => {
    if (site.type === "import-meta") {
      return [];
    }
    const replaced = statement?.(site);
    if (replaced !== undefined) {
      return [{ start: site.importStart, end: site.importEnd, text: replaced }];
    }
    // An `import()`'s span is its argument, quotes and all; a static
    // import's, the specifier's text alone, between its quotes.
    const quoted = JSON.stringify(moduleFor(site.specifier));
    return site.type === "dynamic"
      ? [{ start: site.start, end: site.end, text: quoted }]
      : [{ start: site.start - 1, end: site.end + 1, text: quoted }];
  });
  let text = "";
  let at = 0;
  for (const { start, end, text: edit } of edits) {
    text += code.slice(at, start) + edit;
    at = end;
  }
  return text + code.slice(at);
};

/** Why an import of icons can't be read: it names none of them. */
const iconsByName =
  "import or export icons from lucide-react by name, e.g. { InboxIcon }.";

/**
 * A name a statement takes or gives, which the icons' statements are
 * written with: only ever an identifier, whose name holds nothing but an
 * identifier's characters. A string name (`export { A as "b" }`) is
 * refused: written back, its text could read as code.
 */
const identifierOf = (node: Node | undefined): string => {
  const name = node?.type === "Identifier" ? node.name : undefined;
  if (typeof name !== "string") {
    throw new TypeError(
      "Icons from lucide-react are imported and exported under plain names, never strings: { InboxIcon }, or { InboxIcon as Inbox }."
    );
  }
  return name;
};

/**
 * An import or re-export of lucide-react icons by name (`statement`, as
 * oxc's transform printed it), as one statement per icon from its own
 * module (`moduleOf`): `import local from "icon"`, or `export { default
 * as exported } from "icon"`. Read with oxc's parser.
 */
const iconStatements = (
  statement: string,
  moduleOf: (icon: string) => string
): string => {
  const [read] = children(parsed("icons.js", statement)?.program, "body");
  if (read === undefined) {
    throw new TypeError(iconsByName);
  }
  return children(read, "specifiers")
    .map((each) => {
      if (each.type === "ExportSpecifier") {
        const exported = identifierOf(child(each, "exported"));
        const module = JSON.stringify(
          moduleOf(identifierOf(child(each, "local")))
        );
        return `export{default as ${exported}}from${module}`;
      }
      if (each.type !== "ImportSpecifier") {
        throw new TypeError(iconsByName);
      }
      const local = identifierOf(child(each, "local"));
      const module = JSON.stringify(
        moduleOf(identifierOf(child(each, "imported")))
      );
      return `import ${local} from${module}`;
    })
    .join(";");
};

/** How an import may name an App file: as written, or without its extension. */
const importSuffixes = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

const isRelative = (specifier: string): boolean =>
  specifier.startsWith("./") || specifier.startsWith("../");

/** The App file a relative import names, if there is one. */
export const resolveRelative = (
  importer: string,
  specifier: string,
  files: ReadonlySet<string>
): string | undefined => {
  const parts = importer.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") {
      if (parts.pop() === undefined) {
        return undefined;
      }
    } else if (part !== ".") {
      parts.push(part);
    }
  }
  const path = parts.join("/");
  return importSuffixes
    .map((suffix) => `${path}${suffix}`)
    .find((candidate) => files.has(candidate));
};

/** The packages App code may import from, for error messages. */
const packagesOf = (kit: Kit): string =>
  [
    ...new Set(
      [...kit.imports, "lucide-react"].map((specifier) =>
        specifier
          .split("/")
          .slice(0, specifier.startsWith("@") ? 2 : 1)
          .join("/")
      )
    ),
  ].join(", ");

/** Why an import of lucide-react isn't allowed, or undefined when it is. */
const iconError = (
  names: string[] | undefined,
  kit: Kit
): string | undefined => {
  if (names === undefined) {
    return "import or export icons from lucide-react by name, e.g. { InboxIcon }.";
  }
  const unknown = names.filter((name) => !Object.hasOwn(kit.icons, name));
  return unknown.length === 0
    ? undefined
    : `${unknown.map((name) => `"${name}"`).join(", ")} is not a lucide-react icon.`;
};

/**
 * How a type import may name an App file, as TypeScript resolves one:
 * as written, by its extension (declarations included), or as a folder's
 * index.
 */
const typeSuffixes = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  "/index.ts",
  "/index.tsx",
  "/index.d.ts",
];

const scriptExtension = /\.(?:js|jsx)$/u;

/**
 * The App file a page's type import names, if there is one: resolved
 * as TypeScript would (`./types` for `types.d.ts` or `types/index.d.ts`,
 * `./x.js` for `x.ts`), but only ever among `files`, the build's own, so
 * no path, folder or extension reaches anything else.
 */
const resolveTypeFile = (
  file: string,
  specifier: string,
  files: ReadonlySet<string>
): string | undefined => {
  const parts = file.split("/").slice(0, -1);
  for (const part of specifier.replace(scriptExtension, "").split("/")) {
    if (part === "..") {
      if (parts.pop() === undefined) {
        return undefined;
      }
    } else if (part !== ".") {
      parts.push(part);
    }
  }
  const path = parts.join("/");
  return typeSuffixes
    .map((suffix) => `${path}${suffix}`)
    .find((candidate) => files.has(candidate));
};

/** A specifier TypeScript resolves as a path rather than by name: relative, or absolute. */
const pathSpecifier = /^(?:\.\.?(?:\/|$)|\/)/u;

/**
 * Why a type import of App code that isn't a page's names a path that
 * isn't one of the App's files (`files`, everything the build was given),
 * or undefined when it names a module or one of them. By name, a type
 * reaches only the modules its check gives its kind (type-check.ts);
 * by path, it would reach the kit's files the check holds out of reach.
 */
export const typeFileError = (
  file: string,
  specifier: string | undefined,
  files: ReadonlySet<string>
): string | undefined =>
  specifier !== undefined &&
  pathSpecifier.test(specifier) &&
  (specifier.startsWith("/") ||
    resolveTypeFile(file, specifier, files) === undefined)
    ? `"${specifier}" is not one of the App's files: a type names the App's own files by a relative path, and modules by name.`
    : undefined;

/**
 * Why a type-only import in a page, component or declaration file isn't
 * allowed, or undefined when it is: held to what its values may import,
 * but for the names they may take (a type of the SDK root's beyond
 * `{ v }`, any lucide-react name). An allowlist, so no path reaches what
 * the kit doesn't list: nothing under node_modules, nothing absolute,
 * only the build's own files and the kit's modules by name.
 */
export const pageTypeImportError = (
  { specifier, ambient }: Pick<ImportSite, "specifier" | "ambient">,
  file: string,
  files: ReadonlySet<string>,
  kit: Kit
): string | undefined => {
  // The route tree the host generates registers the App's routes with
  // TanStack Router as TanStack's own generator writes it: augmenting the
  // router's registry, never declaring a module of its own.
  if (ambient && file === routeTreePath && specifier === routerSpecifier) {
    return undefined;
  }
  if (ambient) {
    return specifier === undefined
      ? "declare global is never in a page's files: it would declare globals the page doesn't give the App."
      : `declare module "${specifier}" is never in a page's files: it would declare, or shadow, a module the kit doesn't give the App. Import what the kit has instead.`;
  }
  if (specifier === undefined) {
    return "import() must name a module in quotes.";
  }
  const server = typeImportError(file, specifier, true);
  if (server !== undefined) {
    return server;
  }
  if (isRelative(specifier)) {
    const resolved = resolveTypeFile(file, specifier, files);
    // The server code a build reads for the references' types alone is
    // never a page's, however a path reaches it (a folder's index).
    return resolved === undefined ||
      (isTypeOnlyFile(resolved) && file !== pageReferences.path)
      ? `"${specifier}" is not a file of this App's pages.`
      : undefined;
  }
  if (specifier === pageReferences.specifier) {
    return files.has(pageReferences.path)
      ? undefined
      : `"${specifier}" holds the references the host generates from the App's server code (grasp.config.ts, server/), which this App doesn't have yet.`;
  }
  if (specifier === pageDataModel.specifier) {
    return files.has(pageDataModel.path)
      ? undefined
      : `"${specifier}" holds the types of the App's tables, generated from server/schema.ts, which this App doesn't have yet.`;
  }
  return specifier === "lucide-react" ||
    kit.imports.includes(specifier) ||
    packageModuleIn(files, specifier) !== undefined
    ? undefined
    : `"${specifier}" is outside the kit. Pages can import the App's own files and ${packagesOf(kit)}.`;
};

/**
 * Why a page's value import of `specifier` names a declaration file
 * among `declarations` (`declarationFile`), or undefined when it names
 * none: a declaration holds types alone and is never a module, so a value
 * import of one would be undefined at run time. Resolved among `files`
 * and `declarations` together, in TypeScript's order (`x.tsx` before
 * `x.d.ts`, `x.d.ts` before `x/index.ts`), so the file the type check
 * reads is the file the page runs, or the import is refused.
 */
export const declarationValueImportError = (
  { specifier, typeOnly }: Pick<ImportSite, "specifier" | "typeOnly">,
  file: string,
  {
    files,
    declarations,
  }: {
    readonly files: ReadonlySet<string>;
    readonly declarations: ReadonlySet<string>;
  }
): string | undefined => {
  if (typeOnly || specifier === undefined || !isRelative(specifier)) {
    return undefined;
  }
  const resolved = resolveTypeFile(
    file,
    specifier,
    new Set([...files, ...declarations])
  );
  return resolved !== undefined && declarations.has(resolved)
    ? `"${specifier}" is ${resolved}, a declaration file: it holds only types, so import it with import type.`
    : undefined;
};

/** Why a page's import isn't allowed, or undefined when it is. */
export const importError = (
  { specifier, names, typeOnly, ambient }: ImportSite,
  file: string,
  files: ReadonlySet<string>,
  kit: Kit
): string | undefined => {
  if (typeOnly) {
    return pageTypeImportError({ specifier, ambient }, file, files, kit);
  }
  if (specifier === undefined) {
    return "import() must name a module in quotes.";
  }
  const server = pageImportError(file, specifier);
  if (server !== undefined) {
    return server;
  }
  if (isRelative(specifier)) {
    return resolveRelative(file, specifier, files) === undefined
      ? `"${specifier}" is not a file in this App.`
      : undefined;
  }
  if (specifier === pageReferences.specifier) {
    return files.has(pageReferences.path)
      ? undefined
      : `"${specifier}" holds the references the host generates from the App's server code (grasp.config.ts, server/), which this App doesn't have yet.`;
  }
  if (specifier === "lucide-react") {
    return iconError(names, kit);
  }
  if (
    specifier === sdkRoot &&
    (names === undefined || names.some((name) => !pageRootNames.has(name)))
  ) {
    return `Pages import only { v } from ${sdkRoot}, and its types: the rest is the App's server code.`;
  }
  return kit.imports.includes(specifier) ||
    packageModuleIn(files, specifier) !== undefined
    ? undefined
    : `"${specifier}" is outside the kit and the App's approved packages. Pages can import the App's own files, ${packagesOf(kit)}, and the npm packages its builder approved: ask for one (again, if it was removed) with env.build.resolveDependencies, and import it once it is approved.`;
};

/** What one compiled file imports, by flat module name. */
export interface ModuleImports {
  /** The App's own modules. */
  app: Set<string>;
  /** The kit's modules. */
  kit: Set<string>;
}

/** What the React Compiler's output imports, besides what App code may. */
const compilerRuntime = "react/compiler-runtime";

/**
 * Points a compiled module's imports (`code`, `file`'s) at flat module
 * names: App files by path, kit modules by specifier, and each
 * lucide-react icon at its own module, so a page loads only the icons it
 * uses. It adds the modules it points at to `imported`.
 *
 * It reads compiled code, so it also sees the imports the React Compiler
 * and the JSX transform added, which the check of the source can't: a
 * `@jsxImportSource` comment, for one, makes JSX import from any package.
 * Anything that isn't the kit or the App's own files throws.
 */
export const rewriteImports = (
  code: string,
  file: string,
  files: ReadonlySet<string>,
  kit: Kit,
  imported: ModuleImports
): string => {
  const allowed = new Set([...kit.imports, compilerRuntime]);
  const kitModule = (module: string): string => {
    imported.kit.add(module);
    return module;
  };
  const icon = (name: string): string => {
    const module = ownEntry(kit.icons, name);
    if (module === undefined) {
      throw new Error(`"${name}" is not a lucide-react icon.`);
    }
    return kitModule(module);
  };
  const moduleFor = (specifier: string | undefined): string => {
    if (specifier === undefined) {
      throw new Error("import() must name a module in quotes.");
    }
    if (
      specifier === pageReferences.specifier &&
      files.has(pageReferences.path)
    ) {
      const module = appModuleName(pageReferences.path);
      imported.app.add(module);
      return module;
    }
    const approved = packageModuleIn(files, specifier);
    if (approved !== undefined) {
      imported.app.add(approved);
      return approved;
    }
    if (!isRelative(specifier)) {
      if (!allowed.has(specifier)) {
        throw new Error(
          `"${specifier}" is outside the kit, and the compiled file imports it: remove what adds it, such as a @jsxImportSource comment.`
        );
      }
      return kitModule(kitModuleName(specifier));
    }
    const target = resolveRelative(file, specifier, files);
    if (target === undefined) {
      throw new Error(`"${specifier}" is not a file in this App.`);
    }
    const module = appModuleName(target);
    imported.app.add(module);
    return module;
  };
  return pointImports(code, moduleFor, (site) =>
    site.type === "static" && site.specifier === "lucide-react"
      ? iconStatements(code.slice(site.importStart, site.importEnd), icon)
      : undefined
  );
};

/**
 * Points an approved package's page module (`code`, bundled in core's
 * package builder with the kit's React left out) at the kit: React and
 * React DOM are the kit's own modules, never a copy of the package's, and
 * it imports nothing else. Adds the kit modules it points at to
 * `imported`.
 */
export const rewritePackageImports = (
  code: string,
  kit: Kit,
  imported: ModuleImports
): string =>
  pointImports(code, (specifier) => {
    const module =
      specifier === undefined ? undefined : kitModuleName(specifier);
    if (module === undefined || !Object.hasOwn(kit.moduleImports, module)) {
      throw new Error(
        `An approved package imports ${String(specifier)}, which neither it nor the kit has.`
      );
    }
    imported.kit.add(module);
    return module;
  });

/**
 * Code built here that runs outside the pages: a JSON workflow's
 * generated module. It imports its own files and a few of the platform's
 * modules, by the flat name each is loaded under.
 */
export interface CodeKind {
  /** What the code is, for messages, such as "Workflow". */
  name: string;
  folder: string;
  /** The modules it may import besides its own files, and their flat names. */
  imports: ReadonlyMap<string, string>;
}

/**
 * The runtime's modules core's own entry modules import in the isolates
 * it runs: the workflow runtime a sealed run's host drives
 * (`@grasp-os/runtime/workflow`, sealed-isolate.ts) and the test runner
 * an App's tests run on (`@grasp-os/runtime/testing`, app-tests.ts), and
 * the SDK's testing entry those tests import: built with the runner, so
 * the suites they declare are the ones it runs.
 */
export const sdkImports = [
  "@grasp-os/runtime/workflow",
  "@grasp-os/runtime/testing",
  "@grasp-os/sdk/testing",
] as const;

/**
 * The modules the code the host generates from a JSON workflow
 * (grasp-workflow/2, @grasp-os/workflow-schema) imports: the workflow SDK,
 * the helpers only generated code calls included, and nothing else, not
 * even the testing module beside it.
 */
export const generatedWorkflowSdkImports = ["@grasp-os/sdk/workflow"] as const;

/** Generated workflow code imports only `generatedWorkflowSdkImports`. */
export const generatedWorkflowCode: CodeKind = {
  name: "Generated workflow",
  folder: ".grasp/",
  imports: new Map(
    generatedWorkflowSdkImports.map((specifier) => [
      specifier,
      kitModuleName(specifier),
    ])
  ),
};

const javascriptExtension = /\.js$/u;

/**
 * The file a relative import names: as `resolveRelative` finds it, or
 * written with `.js` for the `.ts` file, as TypeScript's own ES module
 * output wants it.
 */
const resolveCodeFile = (
  importer: string,
  specifier: string,
  files: ReadonlySet<string>
): string | undefined =>
  resolveRelative(importer, specifier, files) ??
  (specifier.endsWith(".js")
    ? resolveRelative(
        importer,
        specifier.replace(javascriptExtension, ".ts"),
        files
      )
    : undefined);

/** Why an import in `kind` code isn't allowed, or undefined when it is. */
export const codeImportError = (
  kind: CodeKind,
  {
    specifier,
    typeOnly,
    ambient,
  }: Pick<ImportSite, "specifier" | "typeOnly" | "ambient">,
  file: string,
  files: ReadonlySet<string>,
  /** What its types may name by path: every file the build was given. */
  typeFiles: ReadonlySet<string> = files
): string | undefined => {
  // Generated workflow code is the host's own: an ambient module there
  // reaches nothing.
  if (ambient) {
    return undefined;
  }
  if (typeOnly) {
    if (specifier !== undefined && kind.imports.has(specifier)) {
      return undefined;
    }
    return (
      typeImportError(file, specifier, false) ??
      typeFileError(file, specifier, typeFiles)
    );
  }
  if (specifier === undefined) {
    return "import() must name a module in quotes.";
  }
  if (isRelative(specifier)) {
    return resolveCodeFile(file, specifier, files) === undefined
      ? `"${specifier}" is not a file of the App's ${kind.name.toLowerCase()} (${kind.folder}).`
      : undefined;
  }
  return kind.imports.has(specifier)
    ? undefined
    : `"${specifier}" can't be imported here. ${kind.name} code can import its own files in ${kind.folder} and ${[...kind.imports.keys()].join(", ")}.`;
};

/**
 * Points a compiled module's imports (`code`, `file`'s) at the flat names
 * of the App's files and the platform's modules. Like `rewriteImports`,
 * it reads compiled code, so it also sees imports the source check can't,
 * and throws on anything `kind` can't import.
 */
export const rewriteCodeImports = (
  code: string,
  kind: CodeKind,
  file: string,
  files: ReadonlySet<string>
): string =>
  pointImports(code, (specifier) => {
    const error = codeImportError(kind, { specifier }, file, files);
    if (error !== undefined || specifier === undefined) {
      throw new Error(error);
    }
    const target = isRelative(specifier)
      ? resolveCodeFile(file, specifier, files)
      : undefined;
    return target === undefined
      ? (kind.imports.get(specifier) ?? specifier)
      : appModuleName(target);
  });

/**
 * Points the imports of a compiled file of an App's server code of spec
 * 8's layout (app-code.ts) at flat module names, throwing on any its kind
 * can't import.
 */
export const rewriteAppCodeImports = (
  code: string,
  file: string,
  files: ReadonlySet<string>
): string =>
  pointImports(code, (specifier) => {
    const resolved = appCodeImport(file, specifier, files);
    if ("error" in resolved) {
      throw new Error(resolved.error);
    }
    return resolved.module;
  });
