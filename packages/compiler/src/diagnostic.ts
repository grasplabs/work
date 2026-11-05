import { designRuleLevels } from "./design-rules.ts";

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

/**
 * Whether `rule` is the design system's (lint.ts): @shadcn/lint's, or
 * one of Grasp's own (design-rules.ts).
 */
export const isDesignRule = (rule: string): boolean =>
  rule.startsWith("shadcn/") || Object.hasOwn(designRuleLevels, rule);

/** What TypeScript names its diagnostics by: `TS` and its code. */
const typeCode = /^TS\d+$/u;

/**
 * Every gate's diagnostics together, none hiding another (GRA-1527):
 * `first`, a file's compile and import errors, then `then`, the type
 * check's and the lint's, less what only says `first` again: a diagnostic
 * on a line `first` has an error on (TypeScript's "cannot find module"
 * beside a refused import), anything else of a file in `unparsed`, which
 * the parser refused (its compile error says where), whose types and lint
 * would only be guessed past the break, and TypeScript's diagnostics of a
 * file in `untyped`, whose JSX runtime was refused (a `@jsxImportSource`
 * pragma), so every element of it is typed against a runtime it never
 * gets: the refusal says what to fix.
 */
export const together = (
  first: readonly Diagnostic[],
  then: readonly Diagnostic[],
  unparsed: ReadonlySet<string>,
  untyped: ReadonlySet<string> = new Set()
): Diagnostic[] => {
  const lines = new Set(
    first
      .filter((diagnostic) => isError(diagnostic))
      .map(({ file, line }) => `${file}:${line}`)
  );
  return [
    ...first,
    ...then.filter(
      ({ file, line, rule }) =>
        !(
          (file !== undefined && unparsed.has(file)) ||
          (file !== undefined && untyped.has(file) && typeCode.test(rule)) ||
          (line !== undefined && lines.has(`${file}:${line}`))
        )
    ),
  ];
};
