/**
 * The admin's build check that every module the browser never runs is
 * marked server-only (`import "@tanstack/react-start/server-only";`).
 * Start's import protection then fails the browser's build if any of a
 * marked module's code survives into it, whatever it imports; this check
 * fails it when a module the browser doesn't load is left unmarked, so a
 * new server module can't slip past. The browser's modules are what its
 * build kept code of; every other module under src/ is the Worker's, and
 * must say so. Tests aren't the app's.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Plugin } from "vite-plus";

/** The marker Start's import protection reads. */
export const serverOnlyMarker = "@tanstack/react-start/server-only";

/** What isn't a module of the app's: tests, and the generated route tree. */
const notTheApp = /(?:\.test\.tsx?|\.d\.ts|routeTree\.gen\.ts)$/u;

/** Every TypeScript module under `dir`, as absolute paths. */
const modulesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter((file) => /\.tsx?$/u.test(file) && !notTheApp.test(file))
    .map((file) => path.join(dir, file));

/**
 * Whether `file` imports the marker. The browser's build keeps no code of
 * a marked module, so `kept` never lists one.
 */
const isMarked = (file: string): boolean =>
  readFileSync(file, "utf-8").includes(`import "${serverOnlyMarker}";`);

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
        `These modules never run in the browser but aren't marked server-only: add import "${serverOnlyMarker}"; at the top of each.\n${unmarked.join("\n")}`
      );
    }
  },
});
