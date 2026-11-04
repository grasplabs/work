/**
 * A problem the compiler found in an App's files, for whoever fixes them
 * (usually an agent). Errors fail the build; warnings don't.
 */
export interface Diagnostic {
  /** The App file, e.g. `screens/desk.tsx`; absent when it is about the App as a whole. */
  file?: string;
  /** 1-based. */
  line?: number;
  /** 1-based. */
  column?: number;
  /**
   * What found it: a TypeScript error code (`TS2322`), a lint rule
   * (`shadcn/no-restyle`), or a compiler stage (`imports`, `compile`).
   */
  rule: string;
  severity: "error" | "warning";
  message: string;
  /** A change that would fix it, when the check suggests one. */
  fix?: string;
}

export const isError = (diagnostic: Diagnostic): boolean =>
  diagnostic.severity === "error";

/** TypeScript's syntax errors (TS1xxx). */
const syntaxCode = /^TS1\d{3}$/u;

/**
 * Every gate's diagnostics together, none hiding another (GRA-1527):
 * `first`, a file's compile and import errors, then `then`, the type
 * check's and the lint's, less what only says `first` again: a diagnostic
 * on a line `first` has an error on (TypeScript's "cannot find module"
 * beside a refused import), and anything else of a file that didn't parse
 * (a compile error, and a syntax error of TypeScript's own), whose types
 * TypeScript only guessed past the break.
 */
export const together = (
  first: readonly Diagnostic[],
  then: readonly Diagnostic[]
): Diagnostic[] => {
  const failed = first.filter((diagnostic) => isError(diagnostic));
  const lines = new Set(failed.map(({ file, line }) => `${file}:${line}`));
  const compiled = new Set(
    failed.filter(({ rule }) => rule === "compile").map(({ file }) => file)
  );
  const unparsed = new Set(
    then
      .filter(({ file, rule }) => syntaxCode.test(rule) && compiled.has(file))
      .map(({ file }) => file)
  );
  return [
    ...first,
    ...then.filter(
      ({ file, line }) =>
        !(
          unparsed.has(file) ||
          (line !== undefined && lines.has(`${file}:${line}`))
        )
    ),
  ];
};
