import { readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { demoGroups } from "./demos.ts";

// The local gallery of Damsko's components (routes/kit_.damsko.tsx)
// against what packages/ui holds: every component and block installed has
// one demo there, so the gallery's journey (e2e/kit-damsko.e2e.ts) draws
// each of them in the product's own build.

const source = path.join(import.meta.dirname, "../../../../packages/ui/src");

/** A folder's parts by name: a file per component, a folder for a few. */
const partsIn = (folder: string): string[] =>
  readdirSync(path.join(source, folder), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.name.endsWith(".tsx"))
    .map((entry) => entry.name.replace(/\.tsx$/u, ""));

describe("the gallery of Damsko's components", () => {
  it("has one demo of every component and block installed", () => {
    const shown = Object.values(demoGroups).flatMap((demos) =>
      Object.keys(demos)
    );
    expect(shown.toSorted()).toStrictEqual(
      ["components", "blocks"]
        .flatMap((folder) =>
          readdirSync(source).includes(folder) ? partsIn(folder) : []
        )
        .toSorted()
    );
  });
});
