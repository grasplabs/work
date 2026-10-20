/**
 * A build diagnostic's category: what kind of problem it is, from a closed
 * set that never names anything of the App's, so it can be logged and
 * counted where a diagnostic's message (App text) can't.
 */
export const diagnosticCategories = [
  /** Past what a build takes: files, characters, modules. */
  "limits",
  /** What a file may import or name, and what would steer the check. */
  "imports",
  /** Code that doesn't parse, or that the React Compiler refuses. */
  "compile",
  /** A type error (TypeScript's `TS####`). */
  "types",
  /** The design system's lint (`shadcn/…`). */
  "design-system",
  /** The App's layout: its screens, server, tests and file names. */
  "structure",
  /** Any other rule: the platform's own, never the App's to fix. */
  "internal",
] as const;

export type DiagnosticCategory = (typeof diagnosticCategories)[number];

/** The rules of the App's layout (`structure`). */
const structureRules: ReadonlySet<string> = new Set([
  "screens",
  "server",
  "tests",
  "file-names",
  "bindings",
]);

/** A TypeScript diagnostic's rule: `TS` and its code. */
const typeRule = /^TS\d+$/u;

/** A lint rule's ID: a plugin's name, a slash, the rule's. */
const lintRule = /^[\w@-]+\/[\w-]+$/u;

/** The category of a diagnostic of rule `rule` (see `diagnosticCategories`). */
export const diagnosticCategory = (rule: string): DiagnosticCategory => {
  if (rule === "limits" || rule === "imports" || rule === "compile") {
    return rule;
  }
  if (typeRule.test(rule)) {
    return "types";
  }
  if (rule === "lint" || lintRule.test(rule)) {
    return "design-system";
  }
  return structureRules.has(rule) ? "structure" : "internal";
};
