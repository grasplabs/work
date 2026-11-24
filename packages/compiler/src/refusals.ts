import type { Diagnostic } from "./diagnostic.ts";
import { pageSources } from "./increments.ts";
import type { CodeFolder } from "./inputs.ts";
import {
  isPageFile,
  pagesFolder,
  sourceCode,
  strayFileMessage,
  strayFilesIn,
} from "./inputs.ts";
import { appModuleName } from "./kit.ts";

// What refuses a build before anything compiles: checks of paths alone,
// which the compiler runs first.

/** Where in a file a diagnostic points. */
export interface Location {
  file?: string;
  line?: number;
  column?: number;
}

/** An error, which fails the build. */
export const problem = (
  rule: string,
  message: string,
  at: Location = {}
): Diagnostic => ({ ...at, rule, severity: "error", message });

/**
 * What `files` hold in `folders` that isn't their code, each refused by
 * name under `rule`: nothing there is ever silently left out of a build.
 */
export const strayProblems = (
  files: Readonly<Record<string, string>>,
  folders: readonly CodeFolder[],
  rule: string
): Diagnostic[] =>
  folders.flatMap((folder) =>
    strayFilesIn(files, folder).map((file) =>
      problem(rule, strayFileMessage(file, folder), { file })
    )
  );

/** Two App files that would share a module name, e.g. `a.ts` and `a.tsx`. */
const nameClashes = (paths: readonly string[]): Diagnostic[] => {
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
 * Why a pages build of `app` (its build files) is refused before
 * anything compiles, or nothing: a stray file in its front end, no
 * page, or two files that would share a module name, in that order.
 */
export const pageRefusals = (
  app: Readonly<Record<string, string>>
): Diagnostic[] => {
  const strays = strayProblems(app, [sourceCode], "pages");
  if (strays.length > 0) {
    return strays;
  }
  // TanStack reads a `__virtual.ts` in the routes as a config of routes
  // of its own, files elsewhere among them: an App's routes are its files
  // under the routes folder, and nothing else decides them.
  const virtual = Object.keys(app).filter(
    (path) =>
      path.startsWith(pagesFolder) && path.split("/").at(-1) === "__virtual.ts"
  );
  if (virtual.length > 0) {
    return virtual.map((file) =>
      problem(
        "pages",
        "An App's routes are its files: a virtual route config is never read.",
        { file }
      )
    );
  }
  const { known } = pageSources(app);
  if (!known.some((path) => isPageFile(path))) {
    return [
      problem(
        "pages",
        `The App has no pages: add one as ${pagesFolder}index.tsx.`
      ),
    ];
  }
  return nameClashes(known);
};
