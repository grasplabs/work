import type { Diagnostic } from "./diagnostic.ts";
import { screenSources } from "./increments.ts";
import type { CodeFolder } from "./inputs.ts";
import {
  componentsFolder,
  screenFile,
  strayFileMessage,
  strayFilesIn,
} from "./inputs.ts";
import { appModuleName } from "./kit.ts";

// What refuses a build before anything compiles: checks of paths alone,
// light enough for core to run before it starts a large App's first build
// in batches (core's screens.ts), as the compiler runs them first.

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
 * Why a screens build of `app` (its build files) is refused before
 * anything compiles, or nothing: a stray file among its components, no
 * screen, or two files that would share a module name, in that order.
 */
export const screenRefusals = (
  app: Readonly<Record<string, string>>
): Diagnostic[] => {
  const strays = strayProblems(app, [componentsFolder], "screens");
  if (strays.length > 0) {
    return strays;
  }
  const { known } = screenSources(app);
  if (!known.some((path) => screenFile.test(path))) {
    return [
      problem(
        "screens",
        "The App has no screens: add one as screens/<name>.tsx."
      ),
    ];
  }
  return nameClashes(known);
};
