/**
 * What a build reads of an App's files, and how much of it a build takes.
 * Core uses these before it hashes and sends the files; the compiler again
 * on what it is sent.
 */
import {
  appLimits,
  appManifestMaxBytes,
  appPathSegmentPattern,
} from "@grasp-os/shared/app-limits";
import { workflowModulesError } from "@grasp-os/shared/workflow-modules";

import type { Diagnostic } from "./diagnostic.ts";
import { screenReferences } from "./kit.ts";

/** Where an App's screens are: one `.tsx` file each (`screenFile`). */
export const screensFolder = "screens/";

export const screenFile = /^screens\/[\w-]+\.tsx$/u;

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
 * at its root, or among its components, in folders named as any App
 * path's may be (`appPathSegmentPattern`). Never compiled into a module,
 * so only a type import may name one (`declarationValueImportError`).
 */
export const declarationFile =
  /^(?:[\w-]+|components\/(?:[\w-][\w.-]*\/)*[\w-][\w.-]*)\.d\.ts$/u;

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
 * The App's components, which its screens import: TypeScript (`.ts`,
 * `.tsx`, declarations included) anywhere under `components/`.
 */
export const componentsFolder: CodeFolder = {
  folder: "components/",
  isFile: (path) =>
    path.startsWith("components/") &&
    typeScriptFile.test(path) &&
    hasAppPathSegments(path),
  holds:
    "the App's components: TypeScript files (*.ts, *.tsx), in folders whose names don't start with a dot",
};

/**
 * The files a build reads: screens, components and declarations, and the
 * references the host generated for the App's server code, which screens
 * import as `@server/_generated/api`.
 */
export const buildFiles = (
  files: Record<string, string>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).filter(
      ([path]) =>
        screenFile.test(path) ||
        path.startsWith(componentsFolder.folder) ||
        declarationFile.test(path) ||
        path === screenReferences.path
    )
  );

/**
 * The module the host generates from a JSON workflow's definition: one
 * file, never anything a person wrote.
 */
export const openWorkflowEntry = ".grasp/workflow.ts";

/**
 * The most characters the generated module may have: four times the
 * largest definition the profile accepts (1 MiB), as it restates each
 * literal once, with a few characters of code around it.
 */
const openWorkflowMaxLength = 4 * 1024 * 1024;

/**
 * Why `files` aren't one generated workflow module within its bounds, if
 * they aren't: exactly `openWorkflowEntry`, at most
 * {@link openWorkflowMaxLength} characters.
 */
export const openWorkflowErrors = (
  files: Record<string, string>
): Diagnostic[] => {
  const paths = Object.keys(files);
  if (paths.length !== 1 || paths[0] !== openWorkflowEntry) {
    return [
      {
        rule: "limits",
        severity: "error",
        message: `A generated workflow is one module, ${openWorkflowEntry}.`,
      },
    ];
  }
  const source = files[openWorkflowEntry] ?? "";
  return source.length > openWorkflowMaxLength
    ? [
        {
          file: openWorkflowEntry,
          rule: "limits",
          severity: "error",
          message: `The generated module has ${source.length} characters; a build takes at most ${openWorkflowMaxLength}.`,
        },
      ]
    : [];
};

/**
 * Why `files` aren't a JSON workflow's compute modules within their bounds
 * (`code/<file>.ts`, workflow-modules.ts), if they aren't.
 */
export const computeModuleErrors = (
  files: Record<string, string>
): Diagnostic[] => {
  const error =
    Object.keys(files).length === 0
      ? "A build of compute modules has at least one module."
      : workflowModulesError(files);
  return error === undefined
    ? []
    : [{ rule: "limits", severity: "error", message: error }];
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
 * (`appManifestMaxBytes`, whatever the size of the App's source), and
 * restates its descriptors at most a few times over (as types and as
 * values). So these bounds admit every manifest the platform accepts,
 * and still cap what one build hands the compiler.
 */
const generatedLimits = {
  files: 8,
  fileLength: 4 * appManifestMaxBytes,
  totalLength: 8 * appManifestMaxBytes,
} as const;

/** Where the generated modules App code imports are, as Convex has them. */
export const generatedServerFolder = "server/_generated/";

/** Where the host's own generated files are, which App code never imports. */
export const hostGeneratedFolder = ".grasp/";

/**
 * Whether `path` is one the host generates (`server/_generated/`,
 * `.grasp/`): never an App's own file, so an App's files never hold one.
 */
export const isGeneratedPath = (path: string): boolean =>
  path.startsWith(generatedServerFolder) ||
  path.startsWith(hostGeneratedFolder);

/**
 * Why a build of an App's server code (`appCodeFiles`) or screens
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
