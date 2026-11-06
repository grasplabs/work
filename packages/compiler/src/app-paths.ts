/**
 * Where a path specifier in an App file points among the App's files, as
 * TypeScript reads it: shared by the compile's import and directive
 * checks (imports.ts, app-code.ts, steering.ts) and the type check's plan
 * (check-plan.ts). It imports nothing: a standalone definition project
 * carries it beside steering.ts (scripts/package-definition-lib.ts).
 */

/** A specifier TypeScript resolves as a path rather than by name: relative, or absolute. */
export const pathSpecifier = /^(?:\.\.?(?:\/|$)|\/)/u;

/**
 * `specifier` from the App file `from`, as a path from the App's root,
 * and whether it climbs above the root on the way, where TypeScript
 * stays at the root.
 */
export const joinedPath = (
  from: string,
  specifier: string
): { path: string; escaped: boolean } => {
  const parts = specifier.startsWith("/") ? [] : from.split("/").slice(0, -1);
  let escaped = false;
  for (const part of specifier.split("/")) {
    if (part === "..") {
      escaped = parts.pop() === undefined || escaped;
    } else if (part !== "." && part !== "") {
      parts.push(part);
    }
  }
  return { path: parts.join("/"), escaped };
};

/** The extension TypeScript replaces when it resolves `./x.js` to `x.ts`. */
const scriptExtension = /\.jsx?$/u;

const typeSuffixes = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  "/index.ts",
  "/index.tsx",
  "/index.d.ts",
];

/**
 * The App files a type may resolve `path` (`joinedPath`'s) to, in
 * TypeScript's order: `./types` to `types.d.ts` or `types/index.d.ts`,
 * `./x.js` to `x.ts`.
 */
export const typeCandidates = (path: string): string[] => {
  const base = path.replace(scriptExtension, "");
  return typeSuffixes.map((suffix) => `${base}${suffix}`);
};
