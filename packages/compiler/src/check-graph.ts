/**
 * What an App file's type check reads of the App's other files, from the
 * compile's own parse (`referencesOf`): the modules it names, and whether
 * what it declares reaches every file. A check too large for one run is
 * run a part at a time on that graph (check-plan.ts). Kept apart from
 * check-plan.ts, which core imports: `graphOf` brings Babel, which only
 * the compiler's isolate has.
 */
import Babel from "@babel/standalone";

import type { FileReferences } from "./check-plan.ts";
import { collectDirectives, collectImports } from "./imports.ts";
import type { ImportSite } from "./imports.ts";
import { ownReferencePath, parserPlugins } from "./steering.ts";
import type { DirectiveSite } from "./steering.ts";

/**
 * How TypeScript tells a module from a script in a target: `auto`, by its
 * imports and exports, `import.meta`, and in a `.tsx` under `react-jsx`
 * by its JSX (pages'); `force`, every file but a declaration file
 * (server code and compute modules, `moduleDetection: "force"`).
 */
export type ModuleDetection = "auto" | "force";

/** What makes a file a module in `auto`, as `noteModule` notes it. */
export interface ModuleNotes {
  syntax: boolean;
  meta: boolean;
  jsx: boolean;
}

export const moduleNotes = (): ModuleNotes => ({
  syntax: false,
  meta: false,
  jsx: false,
});

/** A top-level statement, as far as TypeScript's module indicators read it. */
interface Statement {
  type: string;
  isExport?: boolean;
  moduleReference?: { type: string };
}

/**
 * Whether `statement` makes its file a module, as TypeScript's
 * `isAnExternalModuleIndicatorNode` reads it: an import or export
 * declaration, `export =`, `import x = require("…")`, or
 * `export import x = …`. `import T = NS.T` alone doesn't.
 */
const indicatesModule = ({
  type,
  isExport,
  moduleReference,
}: Statement): boolean => {
  if (type === "TSImportEqualsDeclaration") {
    return (
      isExport === true || moduleReference?.type === "TSExternalModuleReference"
    );
  }
  return [
    "ImportDeclaration",
    "ExportNamedDeclaration",
    "ExportDefaultDeclaration",
    "ExportAllDeclaration",
    "TSExportAssignment",
  ].includes(type);
};

/**
 * A Babel plugin that notes into `noted` what makes a file a module: its
 * statements (`indicatesModule`), `import.meta`, and JSX. It reads the
 * source as written: a compile's plugin list runs it first.
 */
export const noteModule = (noted: ModuleNotes) => () => ({
  visitor: {
    Program: (path: { node: { body: Statement[] } }) => {
      noted.syntax = path.node.body.some(indicatesModule);
    },
    MetaProperty: (path: {
      node: { meta: { name: string }; property: { name: string } };
    }) => {
      if (
        path.node.meta.name === "import" &&
        path.node.property.name === "meta"
      ) {
        noted.meta = true;
      }
    },
    JSXElement: () => {
      noted.jsx = true;
    },
    JSXFragment: () => {
      noted.jsx = true;
    },
  },
});

/**
 * What `path` names of other files, from what a parse with
 * `collectImports`, `collectDirectives` and `noteModule` collected: every
 * module it imports or exports from, by type or by value, `import()`
 * included, and the file its reference path names. It is global when
 * what it declares reaches files that don't import it: a declaration
 * file, a script (`detection`), one that declares a module or globals
 * ambiently, or one with a triple-slash directive (which reaches the
 * whole program).
 */
export const referencesOf = (
  path: string,
  {
    imports,
    directives,
    noted,
  }: {
    imports: readonly ImportSite[];
    directives: readonly DirectiveSite[];
    noted: ModuleNotes;
  },
  detection: ModuleDetection
): FileReferences => {
  const tripleSlash = directives.filter(({ directive }) =>
    directive.startsWith("///")
  );
  const referenced = tripleSlash.flatMap(({ directive }) => {
    const named = ownReferencePath(directive);
    if (named === undefined) {
      return [];
    }
    // A reference path is relative to its file, whether or not it starts with `./`.
    return [named.startsWith("/") ? named : `./${named}`];
  });
  const declaration = path.endsWith(".d.ts");
  const module =
    !declaration &&
    (detection === "force" ||
      noted.syntax ||
      noted.meta ||
      (path.endsWith(".tsx") && noted.jsx));
  return {
    specifiers: [
      ...new Set([
        ...imports.flatMap(({ specifier }) =>
          specifier === undefined ? [] : [specifier]
        ),
        ...referenced,
      ]),
    ],
    global:
      !module ||
      tripleSlash.length > 0 ||
      imports.some(({ ambient }) => ambient === true),
  };
};

/**
 * `source`'s references (`referencesOf`), from a parse of its own, or
 * undefined when it doesn't parse. For a file whose compile stopped part
 * way (the React Compiler refused it), whose collectors may have missed
 * what came after.
 */
export const parsedReferences = (
  path: string,
  source: string,
  detection: ModuleDetection
): FileReferences | undefined => {
  const imports: ImportSite[] = [];
  const directives: DirectiveSite[] = [];
  const noted = moduleNotes();
  try {
    Babel.transform(source, {
      filename: path,
      babelrc: false,
      configFile: false,
      sourceType: "module",
      code: false,
      parserOpts: { plugins: parserPlugins(path) },
      plugins: [
        collectImports(imports),
        collectDirectives(directives),
        noteModule(noted),
      ],
    });
  } catch {
    return undefined;
  }
  return referencesOf(path, { imports, directives, noted }, detection);
};

/** Each of `files`' references (`parsedReferences`): for the build's harness and tests, which compile nothing. */
export const graphOf = (
  files: Readonly<Record<string, string>>,
  detection: ModuleDetection
): Record<string, FileReferences> =>
  Object.fromEntries(
    Object.entries(files).flatMap(([path, source]) => {
      const references = parsedReferences(path, source, detection);
      return references === undefined ? [] : [[path, references]];
    })
  );
