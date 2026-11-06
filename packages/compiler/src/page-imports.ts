import { pageImportError, typeImportError } from "./app-code.ts";
import { compileModule } from "./compile.ts";
import { collectImports } from "./imports.ts";
import type { ImportSite } from "./imports.ts";

// What a page's imports may never reach, as a pages build refuses it
// (worker.ts `compileFile`, before anything else of an import): the App's
// server code and the platform's own modules, by value or, for some, by
// type. The same rules for code checked outside a build, such as the
// guides' examples, so the two can't disagree. What the kit holds is the
// build's to check, against the kit.

/** An import of a page the build refuses, and why. */
export interface PageImportRefusal {
  readonly line: number | undefined;
  readonly message: string;
}

/** The imports of the page file `file` (its `source`) a build refuses for what they reach. */
export const pageServerImports = (
  file: string,
  source: string
): PageImportRefusal[] => {
  const imports: ImportSite[] = [];
  compileModule(source, file, [collectImports(imports)]);
  return imports.flatMap(({ specifier, line, typeOnly }) => {
    const message =
      typeOnly === true
        ? typeImportError(file, specifier, true)
        : pageImportError(file, specifier);
    return message === undefined ? [] : [{ line, message }];
  });
};
