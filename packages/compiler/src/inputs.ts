/**
 * What a build reads of an App's files, and how much of it a build takes.
 * Core uses these before it hashes and sends the files; the compiler again
 * on what it is sent.
 */
import { appLimits, appManifestMaxBytes } from "@grasp-os/shared/app-limits";

import type { Diagnostic } from "./diagnostic.ts";
import { screenReferences } from "./kit.ts";

export const screenFile = /^screens\/[\w-]+\.tsx$/u;
// Folders are plain names, so a path can't step out of `components/`.
export const componentFile = /^components\/(?:[\w-]+\/)*[\w.-]+\.tsx?$/u;
/** Types the App's code can use but that aren't code, e.g. its server's. */
export const declarationFile = /^[\w-]+\.d\.ts$/u;

/**
 * The files a build reads: screens, components and declarations, and the
 * references the host generated for the App's server code, which screens
 * import as `#grasp`.
 */
export const buildFiles = (
  files: Record<string, string>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).filter(
      ([path]) =>
        screenFile.test(path) ||
        componentFile.test(path) ||
        declarationFile.test(path) ||
        path === screenReferences.path
    )
  );

/** The App's server code: TypeScript under `app/`, declarations aside. */
const serverFile = /^app\/(?:[\w-]+\/)*[\w.-]+\.ts$/u;

/** The module that exports the server's `App` class. */
export const serverEntry = "app/server.ts";

/** The files a server build reads: the App's `app/**.ts`. */
export const serverFiles = (
  files: Record<string, string>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).filter(
      ([path]) => serverFile.test(path) && !path.endsWith(".d.ts")
    )
  );

/** The App's workflows and their tests: TypeScript under `workflows/`. */
const workflowFile = /^workflows\/(?:[\w-]+\/)*[\w.-]+\.ts$/u;

/** The files a workflow build reads: the App's `workflows/**.ts`. */
export const workflowFiles = (
  files: Record<string, string>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).filter(
      ([path]) => workflowFile.test(path) && !path.endsWith(".d.ts")
    )
  );

/**
 * Where a workflow's code is, and its tests: `workflows/<id>.ts`, whose
 * default export is the workflow, and `workflows/<id>.workflow-tests.ts`
 * beside it, whose default export is its tests (`workflowTests`). Only
 * `workflows/<id>.ts` (an id without dots) is a workflow: put shared code
 * in a folder under workflows/, such as workflows/lib/.
 */
export const workflowPaths = (
  id: string
): { workflow: string; tests: string } => ({
  workflow: `workflows/${id}.ts`,
  tests: `workflows/${id}.workflow-tests.ts`,
});

/** A workflow's ID, from its file's path; undefined for any other file. */
const workflowPath = /^workflows\/(?<id>[A-Za-z][\w-]{0,63})\.ts$/u;
export const workflowIdOf = (path: string): string | undefined =>
  workflowPath.exec(path)?.groups?.id;

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
 * (`.grasp/`), apart from the App's own files, so an App at its limits
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

/** Whether `path` is where the host puts a module it generates. */
const isGenerated = (path: string): boolean => path.startsWith(".grasp/");

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
    if (isGenerated(path)) {
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
