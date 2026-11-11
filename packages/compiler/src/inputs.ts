import {
  dataModelSource,
  generatedPaths,
  generatedServerFolder,
  serverModuleSource,
} from "@grasp-os/runtime/host";
/**
 * What a build reads of an App's files, and how much of it a build takes.
 * Core uses these before it hashes and sends the files; the compiler again
 * on what it is sent.
 */
import { serverModuleOf } from "@grasp-os/runtime/server-modules";
import {
  appLimits,
  appManifestMaxBytes,
  appPathSegmentPattern,
} from "@grasp-os/shared/app-limits";

import type { Diagnostic } from "./diagnostic.ts";
import { pageDataModel, pageFunctions, pageReferences } from "./kit.ts";

/**
 * Where an App's front end is, as an ordinary Vite React app's: its
 * pages (`pagesFolder`) and its own code, `src/components/` and
 * `src/lib/` by convention, all TypeScript.
 */
export const sourceFolder = "src/";

/**
 * Where an App's pages are: TanStack Router file routes, one `.tsx`
 * file each (`index.tsx` is `/`, `tasks.$taskId.tsx` is `/tasks/$taskId`,
 * `__root.tsx` the layout around them).
 */
export const pagesFolder = "src/routes/";

/**
 * The route tree TanStack's generator makes of the pages
 * (route-tree.ts), as its convention names it: the host's, written into
 * every build, never one of the App's files.
 */
export const routeTreePath = "src/routeTree.gen.ts";

/** The extensions of the TypeScript an App's code is in. */
export const codeExtensions = ["ts", "tsx"] as const;

/** A declaration file's extension: types, not code. */
export const declarationExtension = ".d.ts";

/**
 * What Ultracite lints and formats of an App's files (ultracite.ts):
 * its TypeScript, but its declarations.
 */
export const isLintedCode = (path: string): boolean =>
  codeExtensions.some((extension) => path.endsWith(`.${extension}`)) &&
  !path.endsWith(declarationExtension);
/**
 * Types the App's code can use but that aren't code, e.g. its server's:
 * at its root, or under `src/`, in folders named as any App path's may be
 * (`appPathSegmentPattern`). Never compiled into a module, so only a type
 * import may name one (`declarationValueImportError`).
 */
export const declarationFile =
  /^(?:[\w-]+|src\/(?:[\w$()-][\w.$()-]*\/)*[\w$()-][\w.$()-]*)\.d\.ts$/u;

/**
 * Whether every folder and file name in `path` is one an App's path may
 * have (`appPathSegmentPattern`, what a save allows): dots, but never
 * leading, so no `.`, `..`, empty or hidden one, and a path can't step
 * out of its folder.
 */
export const hasAppPathSegments = (path: string): boolean =>
  path.split("/").every((segment) => appPathSegmentPattern.test(segment));

/**
 * A folder of an App's files that holds one kind of code only: what a
 * file in it must be, and what a refusal says it holds. A build of that
 * code reads the whole folder, so it can refuse what isn't
 * (`strayFilesIn`), by name: nothing there is ever silently left out.
 */
export interface CodeFolder {
  readonly folder: string;
  readonly isFile: (path: string) => boolean;
  readonly holds: string;
}

/** The files in `code`'s folder that aren't its code. */
export const strayFilesIn = (
  files: Readonly<Record<string, string>>,
  { folder, isFile }: CodeFolder
): string[] =>
  Object.keys(files).filter((path) => path.startsWith(folder) && !isFile(path));

/** Why `file`, one of `strayFilesIn(…, code)`, is refused. */
export const strayFileMessage = (
  file: string,
  { folder, holds }: CodeFolder
): string => `${file} is in ${folder}, which holds only ${holds}.`;

const typeScriptFile = /\.tsx?$/u;

/**
 * The App's front end: TypeScript (`.ts`, `.tsx`, declarations included)
 * anywhere under `src/`, its pages under `src/routes/` among it.
 */
export const sourceCode: CodeFolder = {
  folder: sourceFolder,
  isFile: (path) =>
    path.startsWith(sourceFolder) &&
    typeScriptFile.test(path) &&
    hasAppPathSegments(path),
  holds:
    "the App's front end: TypeScript files (*.ts, *.tsx), in folders whose names don't start with a dot",
};

/** Whether `path` is one of the App's pages: a file route under `src/routes/`. */
export const isPageFile = (path: string): boolean =>
  path.startsWith(pagesFolder) &&
  sourceCode.isFile(path) &&
  !path.endsWith(declarationExtension);

/** The root route, TanStack's `__root.tsx`: the layout every page renders in. */
export const rootPage = `${pagesFolder}__root.tsx`;

/**
 * Whether the design system's checks read `path`'s classes (classes.ts):
 * a page or anything else of the App's front end, not a declaration.
 */
export const isDesignLinted = (path: string): boolean =>
  isLintedCode(path) && sourceCode.isFile(path);

/**
 * The root route of an App whose pages have none of their own:
 * TanStack's default, which renders the route matched and nothing around
 * it, as a root route without a component does.
 */
const defaultRoot = `import { createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute();
`;

/** Where the generated module of the server constructors is (`@server/_generated/server`). */
const serverModulePath = generatedPaths.server;

/**
 * Whether `path` is App server code the references' types read
 * (`typeof import("../tasks.ts").list`): its config, values, schema and
 * server modules, and the `internal` tree they import; never its
 * migrations or tests. Read by the pages' type check for their types
 * alone, never compiled into a page, and reported by the server's own
 * check (`isTypeOnlyFile`).
 */
export const isServerTypeFile = (path: string): boolean =>
  path === "grasp.config.ts" ||
  path === "values.ts" ||
  path === generatedPaths.internal ||
  path === "server/schema.ts" ||
  (serverModuleOf(path) !== undefined && !path.endsWith(".test.ts"));

/**
 * Whether `path`, one of a pages build's files (`buildFiles`), is there
 * for its types alone: the App's server code and the modules the host
 * generates for it, whose problems the server's own check reports.
 */
export const isTypeOnlyFile = (path: string): boolean =>
  isServerTypeFile(path) ||
  path === serverModulePath ||
  path === pageDataModel.path;

/**
 * Whether any of `files`' front end names the references
 * (`@server/_generated/api`), so a build of its pages reads them.
 */
export const importsReferences = (
  files: Readonly<Record<string, string>>
): boolean =>
  Object.entries(files).some(
    ([path, source]) =>
      path.startsWith(sourceFolder) && source.includes(pageReferences.specifier)
  );

/**
 * The files a build reads: the App's front end and declarations, the
 * references the host generated for the App's server code, which pages
 * import as `@server/_generated/api`, with the release's functions
 * (`pageFunctions`) and, for their types, the server code they name
 * (`isServerTypeFile`) and the server constructors' module; and, for a
 * front end beside a schema, its data model's types (`pageDataModel`),
 * generated here from it as the host generates them, with the default
 * root route (`defaultRoot`) when the App's pages have none. Never a
 * route tree of the App's own: the build writes the one its pages make
 * (route-tree.ts).
 */
export const buildFiles = (
  files: Record<string, string>
): Record<string, string> => {
  const own = Object.fromEntries(
    Object.entries(files).filter(
      ([path]) =>
        path !== routeTreePath &&
        (path.startsWith(sourceFolder) || declarationFile.test(path))
    )
  );
  // Only for a front end: an App of server code alone has no pages to
  // build. Its references only for one that imports them, so a build
  // reads the same files whether or not they hold their own copy of
  // `server/_generated/` (every save writes one).
  const [schema] = pageDataModel.reads;
  const frontEnd = Object.keys(own).some((path) =>
    path.startsWith(sourceFolder)
  );
  const read = importsReferences(own)
    ? {
        ...own,
        ...Object.fromEntries(
          [pageReferences.path, pageFunctions.path].flatMap((path) => {
            const source = Object.hasOwn(files, path) ? files[path] : undefined;
            return source === undefined ? [] : [[path, source]];
          })
        ),
      }
    : own;
  const typed =
    frontEnd && Object.hasOwn(files, schema)
      ? {
          ...read,
          ...Object.fromEntries(
            pageDataModel.reads.flatMap((path) =>
              Object.hasOwn(files, path) ? [[path, files[path]]] : []
            )
          ),
          [pageDataModel.path]: dataModelSource,
        }
      : read;
  const referenced =
    frontEnd && Object.hasOwn(read, pageReferences.path)
      ? {
          ...typed,
          ...Object.fromEntries(
            Object.entries(files).filter(([path]) => isServerTypeFile(path))
          ),
          [serverModulePath]: serverModuleSource,
          [pageDataModel.path]: dataModelSource,
        }
      : typed;
  const routed = Object.keys(referenced).some((path) => isPageFile(path));
  return routed && !Object.hasOwn(referenced, rootPage)
    ? { ...referenced, [rootPage]: defaultRoot }
    : referenced;
};

/**
 * The module the host generates from a JSON workflow's definition: one
 * file, never anything a person wrote.
 */
export const generatedWorkflowEntry = ".grasp/workflow.ts";

/**
 * The most characters the generated module may have: four times the
 * largest definition grasp-workflow/2 takes (1 MiB, `formatLimits`), as it restates each
 * literal once, with a few characters of code around it.
 */
const generatedWorkflowMaxLength = 4 * 1024 * 1024;

/**
 * Why `files` aren't one generated workflow module within its bounds, if
 * they aren't: exactly `generatedWorkflowEntry`, at most
 * {@link generatedWorkflowMaxLength} characters.
 */
export const generatedWorkflowErrors = (
  files: Record<string, string>
): Diagnostic[] => {
  const paths = Object.keys(files);
  if (paths.length !== 1 || paths[0] !== generatedWorkflowEntry) {
    return [
      {
        rule: "limits",
        severity: "error",
        message: `A generated workflow is one module, ${generatedWorkflowEntry}.`,
      },
    ];
  }
  const source = files[generatedWorkflowEntry] ?? "";
  return source.length > generatedWorkflowMaxLength
    ? [
        {
          file: generatedWorkflowEntry,
          rule: "limits",
          severity: "error",
          message: `The generated module has ${source.length} characters; a build takes at most ${generatedWorkflowMaxLength}.`,
        },
      ]
    : [];
};

/**
 * The most a build takes: as much as an App holds, so any App fits, and a
 * mistake (or an attack) fails fast and says why.
 */
const limits = appLimits;

const tooMuch = (message: string, file?: string): Diagnostic => ({
  ...(file === undefined ? {} : { file }),
  rule: "limits",
  severity: "error",
  message,
});

/** Why a build's files (`buildFiles`) are more than it takes, if they are. */
export const limitErrors = (files: Record<string, string>): Diagnostic[] => {
  const entries = Object.entries(files);
  if (entries.length > limits.files) {
    return [
      tooMuch(
        `The App has ${entries.length} files; a build takes at most ${limits.files}.`
      ),
    ];
  }
  const errors = entries
    .filter(([, source]) => source.length > limits.fileLength)
    .map(([path, source]) =>
      tooMuch(
        `This file has ${source.length} characters; a file can have at most ${limits.fileLength}. Split it up.`,
        path
      )
    );
  const total = entries.reduce((sum, [, source]) => sum + source.length, 0);
  if (total > limits.totalLength) {
    errors.push(
      tooMuch(
        `The App's files have ${total} characters together; a build takes at most ${limits.totalLength}.`
      )
    );
  }
  return errors;
};

/**
 * What a build takes of the modules the host generates for an App
 * (`server/_generated/`, `.grasp/`), apart from the App's own files, so an App at its limits
 * still builds. The host writes them, never the App: each is derived from
 * the App's manifest, which the host has already read and bounded
 * (`appManifestMaxBytes`, whatever the size of the App's source), or
 * from its definition and the names of the functions it registers, and
 * restates its descriptors at most a few times over (as types and as
 * values). So these bounds admit every manifest the platform accepts,
 * and still cap what one build hands the compiler.
 */
const generatedLimits = {
  files: 8,
  fileLength: 4 * appManifestMaxBytes,
  totalLength: 8 * appManifestMaxBytes,
} as const;

/** Where the host's own generated files are, which App code never imports. */
export const hostGeneratedFolder = ".grasp/";

/**
 * Whether `path` is one Grasp generates (`server/_generated/`, `.grasp/`,
 * the route tree), never one a builder writes: a build generates its own,
 * whatever the files hold of it.
 */
export const isGeneratedPath = (path: string): boolean =>
  path.startsWith(generatedServerFolder) ||
  path.startsWith(hostGeneratedFolder) ||
  path === routeTreePath;

/**
 * Why a build of an App's server code (`appCodeFiles`) or pages
 * (`buildFiles`) is more than it takes: the App's own files held to the
 * App's limits (`limitErrors`), the host's generated modules to their own.
 */
export const appCodeLimitErrors = (
  files: Record<string, string>
): Diagnostic[] => {
  const own: Record<string, string> = {};
  const generated: [string, string][] = [];
  for (const [path, source] of Object.entries(files)) {
    if (isGeneratedPath(path)) {
      generated.push([path, source]);
    } else {
      own[path] = source;
    }
  }
  const errors = limitErrors(own);
  if (generated.length > generatedLimits.files) {
    errors.push(
      tooMuch(
        `The host generated ${generated.length} modules; a build takes at most ${generatedLimits.files}.`
      )
    );
  }
  const oversized = generated.filter(
    ([, source]) => source.length > generatedLimits.fileLength
  );
  for (const [path, source] of oversized) {
    errors.push(
      tooMuch(
        `This generated module has ${source.length} characters; a build takes at most ${generatedLimits.fileLength}.`,
        path
      )
    );
  }
  const total = generated.reduce((sum, [, source]) => sum + source.length, 0);
  if (total > generatedLimits.totalLength) {
    errors.push(
      tooMuch(
        `The generated modules have ${total} characters together; a build takes at most ${generatedLimits.totalLength}.`
      )
    );
  }
  return errors;
};
