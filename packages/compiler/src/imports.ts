import {
  appCodeImport,
  screenImportError,
  typeImportError,
} from "./app-code.ts";
import {
  appModuleName,
  kitModuleName,
  ownEntry,
  screenReferences,
  screenRootNames,
  sdkRoot,
} from "./kit.ts";
import type { Kit } from "./kit.ts";

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

/** The parts of Babel's AST the import scan and rewrite read and write. */
interface Name {
  type: string;
  name?: string;
  value?: string;
}
interface Specifier {
  type: string;
  local: Name;
  imported?: Name;
  exported?: Name;
  importKind?: string | null;
  exportKind?: string | null;
}
interface StringLiteral {
  type: string;
  value: string;
}
interface Statement {
  type: string;
  loc?: { start: { line: number } } | null;
  source?: StringLiteral | null;
  /** `import X = require("…")`'s module (`TSExternalModuleReference`). */
  moduleReference?: { type: string; expression?: StringLiteral };
  specifiers?: Specifier[];
  importKind?: string | null;
  exportKind?: string | null;
}
interface Call {
  callee: { type: string; name?: string };
  arguments: { type: string; value?: unknown }[];
  loc?: { start: { line: number } } | null;
}

const moduleStatements = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
]);

/** An import, or an export from another module (`export … from`). */
const isModuleStatement = (statement: Statement): boolean =>
  moduleStatements.has(statement.type) &&
  statement.source !== null &&
  statement.source !== undefined;

const isTypeSpecifier = (specifier: Specifier): boolean =>
  specifier.importKind === "type" || specifier.exportKind === "type";

/** The specifiers that bring in values; types are erased when compiling. */
const valueSpecifiers = (statement: Statement): Specifier[] =>
  (statement.specifiers ?? []).filter(
    (specifier) => !isTypeSpecifier(specifier)
  );

/** An `import type`, or an import whose every name is a type. */
const isTypeOnly = (statement: Statement): boolean =>
  statement.importKind === "type" ||
  statement.exportKind === "type" ||
  ((statement.specifiers ?? []).length > 0 &&
    valueSpecifiers(statement).length === 0);

const nameOf = (name: Name | undefined): string | undefined =>
  name?.name ?? name?.value;

/** The name a specifier takes from the other module. */
const importedName = (specifier: Specifier): string | undefined =>
  specifier.type === "ExportSpecifier"
    ? nameOf(specifier.local)
    : nameOf(specifier.imported);

const namedSpecifiers = new Set(["ImportSpecifier", "ExportSpecifier"]);

/**
 * The names a statement takes from the other module, or undefined when it
 * takes a default, a namespace or everything (`export *`).
 */
const namesOf = (statement: Statement): string[] | undefined => {
  if (statement.type === "ExportAllDeclaration") {
    return undefined;
  }
  const names = valueSpecifiers(statement).map((specifier) =>
    namedSpecifiers.has(specifier.type) ? importedName(specifier) : undefined
  );
  return names.every((name) => name !== undefined) ? names : undefined;
};

const isImportCall = (call: Call): boolean => call.callee.type === "Import";

/** `import(x)` as Babel may also parse it: an `ImportExpression` node. */
interface ImportExpression {
  source: Call["arguments"][number];
  loc?: Call["loc"];
}

/**
 * An `ImportExpression` as the `import()` call the visitors read. Its
 * source is the same node, so rewriting the call's argument rewrites it.
 */
const asImportCall = ({ source, loc }: ImportExpression): Call => ({
  callee: { type: "Import" },
  arguments: [source],
  loc,
});

const stringArgument = (call: Call): string | undefined => {
  const [first] = call.arguments;
  return first?.type === "StringLiteral" && typeof first.value === "string"
    ? first.value
    : undefined;
};

/** A `declare module`, `declare global` or `namespace`: named by a string, or an identifier. */
interface ModuleDeclaration {
  id: { type: string; value?: unknown; name?: string };
  loc?: Call["loc"];
  /** Set on `declare global { … }`. */
  global?: boolean;
}

/** A type's `import("…")` (`typeof import()`, `import("…").Name`). */
interface ImportType {
  argument: { type: string; value?: unknown };
  loc?: Call["loc"];
}

/**
 * A Babel plugin that lists a file's imports into `imports`, as written:
 * it reads the top-level statements before anything else runs. Type-only
 * imports are listed as such (`typeOnly`): erased by the compile, they
 * still name modules, and some no file may name.
 */
export const collectImports = (imports: ImportSite[]) => () => {
  const collect = (call: Call): void => {
    if (isImportCall(call)) {
      imports.push({
        specifier: stringArgument(call),
        line: call.loc?.start.line,
        names: undefined,
      });
    }
  };
  const collectImportType = ({ argument, loc }: ImportType): void => {
    imports.push({
      specifier:
        argument.type === "StringLiteral" && typeof argument.value === "string"
          ? argument.value
          : undefined,
      line: loc?.start.line,
      names: undefined,
      typeOnly: true,
    });
  };
  return {
    visitor: {
      Program: (path: {
        node: { body: Statement[] };
        traverse: (visitor: {
          TSImportType: (inner: { node: ImportType }) => void;
          TSModuleDeclaration: (inner: { node: ModuleDeclaration }) => void;
        }) => void;
      }) => {
        // A type's `import("…")` sits in types the TypeScript transform
        // removes as it goes, and so does an ambient module: read them all
        // now, before it runs.
        path.traverse({
          TSImportType: (inner) => {
            collectImportType(inner.node);
          },
          TSModuleDeclaration: ({ node: { id, loc, global } }) => {
            // `declare global { … }`: what it declares, every file sees.
            if (
              global === true ||
              (id.type === "Identifier" && id.name === "global")
            ) {
              imports.push({
                specifier: undefined,
                line: loc?.start.line,
                names: undefined,
                typeOnly: true,
                ambient: true,
              });
            } else if (
              id.type === "StringLiteral" &&
              typeof id.value === "string"
            ) {
              imports.push({
                specifier: id.value,
                line: loc?.start.line,
                names: undefined,
                typeOnly: true,
                ambient: true,
              });
            }
          },
        });
        for (const statement of path.node.body) {
          const { moduleReference } = statement;
          if (
            statement.type === "TSImportEqualsDeclaration" &&
            moduleReference?.type === "TSExternalModuleReference"
          ) {
            // `import X = require("…")`: a value, or with `type` a type.
            imports.push({
              specifier: moduleReference.expression?.value,
              line: statement.loc?.start.line,
              names: undefined,
              ...(statement.importKind === "type"
                ? { typeOnly: true as const }
                : {}),
            });
          }
          if (isModuleStatement(statement)) {
            imports.push(
              isTypeOnly(statement)
                ? {
                    specifier: statement.source?.value,
                    line: statement.loc?.start.line,
                    names: undefined,
                    typeOnly: true,
                  }
                : {
                    specifier: statement.source?.value,
                    line: statement.loc?.start.line,
                    names: namesOf(statement),
                  }
            );
          }
        }
      },
      CallExpression: (path: { node: Call }) => {
        collect(path.node);
      },
      ImportExpression: (path: { node: ImportExpression }) => {
        collect(asImportCall(path.node));
      },
    },
  };
};

/** A comment as Babel keeps it: its text, without its delimiters. */
interface Comment {
  type: string;
  value: string;
  loc?: { start: { line: number } } | null;
}

/** A comment TypeScript reads as a directive to the type check. */
export interface DirectiveSite {
  /** What it says, e.g. `/// <reference lib="dom" />` or `@ts-ignore`. */
  directive: string;
  line: number | undefined;
}

/**
 * A triple-slash directive TypeScript obeys: `/// <reference …/>`,
 * `/// <amd-module …/>` or `/// <amd-dependency …/>`. Any other tag in a
 * `///` comment (`/// <summary>`) is a comment to it.
 */
const tripleSlash = /^\/\s*<(?:reference|amd-module|amd-dependency)\b/iu;

/**
 * A comment that switches the type check off for the whole file: a
 * `@ts-nocheck` pragma, which TypeScript reads in any case
 * (`@ts-NoCheck`). Refused wherever a comment holds it, stricter than
 * TypeScript, which reads it only where a pragma goes.
 */
const fileSuppression = /@ts-nocheck\b/iu;

/**
 * A comment line that switches the type check off for the next line: one
 * that starts, after any `/` or `*` and space, with `@ts-ignore` or
 * `@ts-expect-error`, where TypeScript reads them (in a line comment, or
 * on any line of a block comment). A comment that only mentions one
 * (`// Do not use @ts-ignore here.`) is prose to it, and to the build.
 */
// No word boundary after it, as TypeScript has none: it reads
// `// @ts-ignoreX` as `@ts-ignore`.
const lineSuppression = /^[\s/*]*@ts-(?:ignore|expect-error)/iu;

/** The suppression `comment` holds where TypeScript would obey it, if any. */
const suppressionIn = (comment: string): string | undefined =>
  fileSuppression.exec(comment)?.[0] ??
  comment
    .split("\n")
    .map((line) =>
      lineSuppression
        .exec(line)?.[0]
        .trim()
        .replace(/^[\s/*]*/u, "")
    )
    .find((found) => found !== undefined);

/**
 * A Babel plugin that lists into `directives` every comment of a file
 * TypeScript would obey as a directive to its type check rather than
 * read as a comment: a triple-slash directive (`/// <reference lib>`,
 * `types`, `path`, which reach the whole program, not only the file), or
 * a suppression (`@ts-nocheck`, `@ts-ignore`, `@ts-expect-error`).
 */
export const collectDirectives = (directives: DirectiveSite[]) => () => ({
  visitor: {
    Program: (
      _path: unknown,
      state: { file: { ast: { comments?: Comment[] | null } } }
    ) => {
      for (const { type, value, loc } of state.file.ast.comments ?? []) {
        const line = loc?.start.line;
        if (type === "CommentLine" && tripleSlash.test(value)) {
          directives.push({ directive: `//${value}`.trim(), line });
        } else {
          const directive = suppressionIn(value);
          if (directive !== undefined) {
            directives.push({ directive, line });
          }
        }
      }
    },
  },
});

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
 * The App file a screen's type import names, if there is one: resolved
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

/**
 * Why a type-only import in a screen, component or declaration file isn't
 * allowed, or undefined when it is: held to what its values may import,
 * but for the names they may take (a type of the SDK root's beyond
 * `{ v }`, any lucide-react name). An allowlist, so no path reaches what
 * the kit doesn't list: nothing under node_modules, nothing absolute,
 * only the build's own files and the kit's modules by name.
 */
export const screenTypeImportError = (
  { specifier, ambient }: Pick<ImportSite, "specifier" | "ambient">,
  file: string,
  files: ReadonlySet<string>,
  kit: Kit
): string | undefined => {
  if (ambient) {
    return specifier === undefined
      ? "declare global is never in a screen's files: it would declare globals the page doesn't give the App."
      : `declare module "${specifier}" is never in a screen's files: it would declare, or shadow, a module the kit doesn't give the App. Import what the kit has instead.`;
  }
  if (specifier === undefined) {
    return "import() must name a module in quotes.";
  }
  const server = typeImportError(file, specifier, true);
  if (server !== undefined) {
    return server;
  }
  if (isRelative(specifier)) {
    return resolveTypeFile(file, specifier, files) === undefined
      ? `"${specifier}" is not a file of this App's screens.`
      : undefined;
  }
  if (specifier === screenReferences.specifier) {
    return files.has(screenReferences.path)
      ? undefined
      : `"${specifier}" holds the references the host generates from the App's server code (app.ts, schema.ts, operations/), which this App doesn't have yet.`;
  }
  return specifier === "lucide-react" || kit.imports.includes(specifier)
    ? undefined
    : `"${specifier}" is outside the kit. Screens can import the App's own files and ${packagesOf(kit)}.`;
};

/** Why a screen's import isn't allowed, or undefined when it is. */
export const importError = (
  { specifier, names, typeOnly, ambient }: ImportSite,
  file: string,
  files: ReadonlySet<string>,
  kit: Kit
): string | undefined => {
  if (typeOnly) {
    return screenTypeImportError({ specifier, ambient }, file, files, kit);
  }
  if (specifier === undefined) {
    return "import() must name a module in quotes.";
  }
  const server = screenImportError(file, specifier);
  if (server !== undefined) {
    return server;
  }
  if (isRelative(specifier)) {
    return resolveRelative(file, specifier, files) === undefined
      ? `"${specifier}" is not a file in this App.`
      : undefined;
  }
  if (specifier === screenReferences.specifier) {
    return files.has(screenReferences.path)
      ? undefined
      : `"${specifier}" holds the references the host generates from the App's server code (app.ts, schema.ts, operations/), which this App doesn't have yet.`;
  }
  if (specifier === "lucide-react") {
    return iconError(names, kit);
  }
  if (
    specifier === sdkRoot &&
    (names === undefined || names.some((name) => !screenRootNames.has(name)))
  ) {
    return `Screens import only { v } from ${sdkRoot}, and its types: the rest is the App's server code.`;
  }
  return kit.imports.includes(specifier)
    ? undefined
    : `"${specifier}" is outside the kit. Screens can import the App's own files and ${packagesOf(kit)}.`;
};

/**
 * One icon's import or re-export, from its own module: `import local from
 * "icon"`, or `export { default as exported } from "icon"`.
 */
const fromIconModule = (specifier: Specifier, module: string): Statement => {
  const source = { type: "StringLiteral", value: module };
  if (specifier.type === "ExportSpecifier") {
    return {
      type: "ExportNamedDeclaration",
      exportKind: "value",
      specifiers: [
        {
          type: "ExportSpecifier",
          local: { type: "Identifier", name: "default" },
          exported: specifier.exported ?? specifier.local,
        },
      ],
      source,
    };
  }
  return {
    type: "ImportDeclaration",
    importKind: "value",
    specifiers: [{ type: "ImportDefaultSpecifier", local: specifier.local }],
    source,
  };
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
 * A Babel plugin that points a compiled module's imports at flat module
 * names: App files by path, kit modules by specifier, and each lucide-react
 * icon at its own module, so a page loads only the icons it uses. It adds
 * the modules it points at to `imported`.
 *
 * It runs on compiled code, so it also sees the imports the compiler and
 * the JSX transform added, which the check of the source can't: a
 * `@jsxImportSource` comment, for one, makes JSX import from any package.
 * Anything that isn't the kit or the App's own files throws.
 */
export const rewriteImports =
  (
    file: string,
    files: ReadonlySet<string>,
    kit: Kit,
    imported: ModuleImports
  ) =>
  () => {
    const allowed = new Set([...kit.imports, compilerRuntime]);
    const kitModule = (module: string | undefined): string => {
      if (module === undefined) {
        throw new Error("Not a lucide-react icon.");
      }
      imported.kit.add(module);
      return module;
    };
    const moduleFor = (specifier: string): string => {
      if (
        specifier === screenReferences.specifier &&
        files.has(screenReferences.path)
      ) {
        const module = appModuleName(screenReferences.path);
        imported.app.add(module);
        return module;
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
    const rewriteCall = (call: Call): void => {
      const [first] = call.arguments;
      if (isImportCall(call) && typeof first?.value === "string") {
        first.value = moduleFor(first.value);
      }
    };
    const icons = (statement: Statement): Statement[] =>
      valueSpecifiers(statement).map((specifier) =>
        fromIconModule(
          specifier,
          kitModule(ownEntry(kit.icons, importedName(specifier) ?? ""))
        )
      );
    return {
      visitor: {
        Program: (path: {
          node: { body: Statement[] };
          scope: { crawl: () => void };
        }) => {
          path.node.body = path.node.body.flatMap((statement) => {
            const { source } = statement;
            if (!isModuleStatement(statement) || !source) {
              return [statement];
            }
            if (source.value === "lucide-react") {
              return icons(statement);
            }
            source.value = moduleFor(source.value);
            return [statement];
          });
          path.scope.crawl();
        },
        CallExpression: (path: { node: Call }) => {
          rewriteCall(path.node);
        },
        ImportExpression: (path: { node: ImportExpression }) => {
          rewriteCall(asImportCall(path.node));
        },
      },
    };
  };

/**
 * App code that runs outside the screens: its server (`app/`) or its
 * workflows (`workflows/`). Each imports its own files and a few of the
 * platform's modules, by the flat name each is loaded under.
 */
export interface CodeKind {
  /** What the code is, for messages: "Server" or "Workflow". */
  name: string;
  folder: string;
  /** The modules it may import besides its own files, and their flat names. */
  imports: ReadonlyMap<string, string>;
}

/** Server code imports its own files and the Workers runtime. */
export const serverCode: CodeKind = {
  name: "Server",
  folder: "app/",
  imports: new Map([["cloudflare:workers", "cloudflare:workers"]]),
};

/**
 * The SDK modules workflow code may import: the workflow SDK and its test
 * harness, never the engine and never the Workers runtime.
 */
export const sdkImports = [
  "@grasp-os/sdk/workflow",
  "@grasp-os/sdk/testing",
] as const;

/** Workflow code imports its own files and the SDK (`sdkImports`). */
export const workflowCode: CodeKind = {
  name: "Workflow",
  folder: "workflows/",
  imports: new Map(
    sdkImports.map((specifier) => [specifier, kitModuleName(specifier)])
  ),
};

/**
 * The SDK module the code the host generates from a JSON workflow imports
 * (`@grasp-os/sdk/open-workflow`), and nothing else: App workflows can't
 * import it, nor it anything of theirs.
 */
export const openWorkflowSdkImports = ["@grasp-os/sdk/open-workflow"] as const;

/** Generated workflow code imports only `openWorkflowSdkImports`. */
export const generatedWorkflowCode: CodeKind = {
  name: "Generated workflow",
  folder: ".grasp/",
  imports: new Map(
    openWorkflowSdkImports.map((specifier) => [
      specifier,
      kitModuleName(specifier),
    ])
  ),
};

/**
 * The SDK module a JSON workflow's compute modules (`code/`) import
 * (`@grasp-os/sdk/compute`), and nothing else of the platform: no Workers
 * runtime, no workflow engine, no server constructors, and no packages
 * (approved packages for computations are GRA-665). A calculation gets
 * only the value it is called with.
 */
export const computeSdkImports = ["@grasp-os/sdk/compute"] as const;

/** What core's compute call loads besides them (never importable). */
export const computeRunnerImports = ["@grasp-os/sdk/compute-runner"] as const;

/** Compute modules import their own files and `computeSdkImports`. */
export const computeCode: CodeKind = {
  name: "Compute module",
  folder: "code/",
  imports: new Map(
    computeSdkImports.map((specifier) => [specifier, kitModuleName(specifier)])
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
  files: ReadonlySet<string>
): string | undefined => {
  // Its types are stripped, never checked (GRA-675 checks them): an
  // ambient module there reaches nothing yet.
  if (ambient) {
    return undefined;
  }
  if (typeOnly) {
    return typeImportError(file, specifier, false);
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

const isRequireCall = ({ callee }: Call): boolean =>
  callee.type === "Identifier" && callee.name === "require";

/**
 * A Babel plugin that points a module's imports at the flat names
 * `moduleFor` gives them, which throws for one that isn't allowed:
 * `require()` included, which is never available in `what`.
 */
const rewriteWith =
  (moduleFor: (specifier: string | undefined) => string, what: string) =>
  () => {
    const rewriteCall = (call: Call): void => {
      if (isImportCall(call)) {
        const module = moduleFor(stringArgument(call));
        const [first] = call.arguments;
        if (first) {
          first.value = module;
        }
      }
    };
    return {
      visitor: {
        Program: (path: { node: { body: Statement[] } }) => {
          for (const statement of path.node.body) {
            if (isModuleStatement(statement) && statement.source) {
              statement.source.value = moduleFor(statement.source.value);
            }
          }
        },
        CallExpression: (path: { node: Call }) => {
          if (isRequireCall(path.node)) {
            throw new Error(
              `require() isn't available in ${what}: use import.`
            );
          }
          rewriteCall(path.node);
        },
        ImportExpression: (path: { node: ImportExpression }) => {
          rewriteCall(asImportCall(path.node));
        },
      },
    };
  };

/**
 * A Babel plugin that points a module's imports at the flat names of the
 * App's files and the platform's modules. Like `rewriteImports`, it runs
 * on compiled code, so it also sees imports the source check can't, and
 * throws on anything `kind` can't import, `require()` included.
 */
export const rewriteCodeImports = (
  kind: CodeKind,
  file: string,
  files: ReadonlySet<string>
) =>
  rewriteWith((specifier) => {
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
  }, `${kind.name.toLowerCase()} code`);

/**
 * A Babel plugin that points the imports of a file of an App's server code
 * of spec 8's layout (app-code.ts) at flat module names, throwing on any
 * its kind can't import.
 */
export const rewriteAppCodeImports = (
  file: string,
  files: ReadonlySet<string>
) =>
  rewriteWith((specifier) => {
    const resolved = appCodeImport(file, specifier, files);
    if ("error" in resolved) {
      throw new Error(resolved.error);
    }
    return resolved.module;
  }, "server code");
