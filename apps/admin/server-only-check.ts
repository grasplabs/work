/**
 * The admin's build check that every module the browser never runs is
 * marked server-only (`import "@tanstack/react-start/server-only";`).
 * Start's import protection then fails the browser's build if any of a
 * marked module's code survives into it, whatever it imports; this check
 * fails it when a module the browser's build left out entirely is left
 * unmarked, so a new server module can't slip past. Tests aren't the app's.
 *
 * What it doesn't do: a module the browser keeps any code of is never
 * required to be marked, so this check protects nothing the browser uses.
 * What keeps the Worker's code out of those modules is the import
 * protection's denials alone (vite.config.ts): an import of
 * `cloudflare:workers`, `drizzle-orm`, `src/db/**`, a `*.server.*` file,
 * the tests' helpers, or a marked module. A module the browser loads that
 * holds server logic without any of those passes both.
 *
 * Server functions' own files (`*-functions.ts`) are such modules: the
 * browser keeps them as the functions' stubs, and everything at their
 * module scope ships with them. They hold nothing but `createServerFn`
 * definitions and what the browser may see (their input schemas, types):
 * whatever their handlers need lives in marked modules they import.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseSync } from "vite-plus";
import type { Plugin } from "vite-plus";

/** The marker Start's import protection reads. */
export const serverOnlyMarker = "@tanstack/react-start/server-only";

/** The app's modules, in any language the build reads. */
const sourceFile = /\.[cm]?[jt]sx?$/u;

/** What isn't a module of the app's: tests, declarations, and the generated route tree. */
const notTheApp = /(?:\.test\.[cm]?[jt]sx?|\.d\.[cm]?ts|routeTree\.gen\.ts)$/u;

/** Every module under `dir`, as absolute paths. */
const modulesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter((file) => sourceFile.test(file) && !notTheApp.test(file))
    .map((file) => path.join(dir, file));

/**
 * Whether `file` imports the marker in a real import declaration, read
 * by a parser: never a comment or a string that quotes it.
 */
const isMarked = (file: string): boolean =>
  parseSync(file, readFileSync(file, "utf-8")).program.body.some(
    (statement) =>
      statement.type === "ImportDeclaration" &&
      statement.source.value === serverOnlyMarker
  );

/**
 * The modules the browser's build left out (`kept` holds what it kept code
 * of) that aren't marked server-only, relative to `src`.
 */
export const unmarkedServerModules = (
  src: string,
  kept: ReadonlySet<string>
): string[] =>
  modulesUnder(src)
    .filter((file) => !kept.has(file) && !isMarked(file))
    .map((file) => path.relative(src, file))
    .toSorted();

/** The check, on the browser's build alone. */
export const serverOnlyCheck = (src: string): Plugin => ({
  name: "grasp-admin-server-only",
  apply: "build",
  applyToEnvironment: (environment) => environment.name === "client",
  generateBundle(_options, bundle) {
    const kept = new Set<string>();
    for (const output of Object.values(bundle)) {
      if (output.type === "chunk") {
        for (const [id, module] of Object.entries(output.modules)) {
          if (module.renderedLength > 0) {
            kept.add(id.split("?")[0] ?? id);
          }
        }
      }
    }
    const unmarked = unmarkedServerModules(src, kept);
    if (unmarked.length > 0) {
      this.error(
        [
          "These modules never run in the browser but aren't marked server-only:",
          ...unmarked,
          `Each one is either the Worker's: add import "${serverOnlyMarker}"; at its top; or meant for the browser: import it where the browser uses it (a module that moves to the browser loses its marker, or its build fails).`,
        ].join("\n")
      );
    }
  },
});
