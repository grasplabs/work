import { readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { graspComponents, shadcnComponents } from "../catalog/inventory.ts";
import type { CatalogEntry } from "../catalog/inventory.ts";

// The inventory against what the kit really exports: screens import
// `@grasp-os/ui/components/<name>`, one module per file of the components
// directory, so every file is an entry, and every entry in the kit is a
// file that exports exactly what the entry lists.

const componentsDir = path.join(import.meta.dirname, "../src/components");
const shipped = new Set(
  readdirSync(componentsDir)
    .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))
    .map((file) => file.slice(0, -".tsx".length))
);

const entries: [string, CatalogEntry][] = [
  ...Object.entries(shadcnComponents),
  ...Object.entries(graspComponents),
];
const supported = entries.flatMap(([name, entry]) =>
  entry.status === "supported" ? [{ name, exports: entry.exports }] : []
);

describe("the kit's inventory", () => {
  it("names each component once", () => {
    const shadcnNames = Object.keys(shadcnComponents);
    for (const name of Object.keys(graspComponents)) {
      expect(shadcnNames).not.toContain(name);
    }
  });

  it("has an entry in the kit for every module screens can import", () => {
    const listed = new Set(supported.map(({ name }) => name));
    expect([...shipped].filter((name) => !listed.has(name))).toStrictEqual([]);
  });

  it("has a module for every component it lists as in the kit", () => {
    expect(
      supported.map(({ name }) => name).filter((name) => !shipped.has(name))
    ).toStrictEqual([]);
  });

  it("lists exactly what each module exports", async () => {
    for (const { name, exports } of supported) {
      // oxlint-disable-next-line no-await-in-loop -- one module at a time keeps a failure readable
      const module: unknown = await import(`../src/components/${name}.tsx`);
      expect({
        name,
        exports: Object.keys(module ?? {}).toSorted(),
      }).toStrictEqual({
        name,
        exports: [...exports].toSorted(),
      });
    }
  });

  it("has no module for a component it says the kit doesn't have", () => {
    const missing = entries.flatMap(([name, entry]) =>
      entry.status === "supported" ? [] : [name]
    );
    expect(missing.filter((name) => shipped.has(name))).toStrictEqual([]);
  });

  it("says why for every component the kit leaves out", () => {
    const unsupported = entries.flatMap(([name, entry]) =>
      entry.status === "unsupported" ? [{ name, ...entry }] : []
    );
    expect(
      unsupported
        .filter(({ reason }) => reason.trim() === "")
        .map(({ name }) => name)
    ).toStrictEqual([]);
    expect(
      unsupported
        .filter(({ instead }) => instead !== undefined && !shipped.has(instead))
        .map(({ name }) => name)
    ).toStrictEqual([]);
  });
});
