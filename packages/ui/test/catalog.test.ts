import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { demos } from "../catalog/demos.ts";
import { loadExample } from "../catalog/examples.ts";
import {
  examples,
  graspComponents,
  shadcnComponents,
} from "../catalog/inventory.ts";
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

const examplesDir = path.join(import.meta.dirname, "../catalog/examples");
const componentImport =
  /from "@grasp-os\/ui\/components\/(?<component>[a-z-]+)"/gu;

describe("the kit's examples", () => {
  it("has an entry for every example file", () => {
    const files = readdirSync(examplesDir).map((file) =>
      file.slice(0, -".tsx".length)
    );
    expect(files.toSorted()).toStrictEqual(Object.keys(examples).toSorted());
  });

  it("lists exactly the components each example imports", () => {
    for (const [name, example] of Object.entries(examples)) {
      const source = readFileSync(
        path.join(examplesDir, `${name}.tsx`),
        "utf-8"
      );
      const imported = new Set(
        [...source.matchAll(componentImport)].flatMap((match) =>
          match.groups?.component === undefined ? [] : [match.groups.component]
        )
      );
      expect({ name, uses: [...imported].toSorted() }).toStrictEqual({
        name,
        uses: [...example.uses].toSorted(),
      });
    }
  });

  it("loads each example by its name, and it renders (a smoke test)", async () => {
    for (const [name, load] of Object.entries(loadExample)) {
      // oxlint-disable-next-line no-await-in-loop -- one example at a time keeps a failure readable
      const Example = await load();
      expect({
        name,
        rendered: renderToStaticMarkup(createElement(Example)).length > 0,
      }).toStrictEqual({ name, rendered: true });
    }
  });
});

describe("the kit's demos", () => {
  it("has a demo of every component in the kit, and each renders (a smoke test)", () => {
    const names = supported.map(({ name }) => name).toSorted();
    expect(Object.keys(demos).toSorted()).toStrictEqual(names);
    for (const [name, Demo] of Object.entries(demos)) {
      expect({
        name,
        rendered: renderToStaticMarkup(createElement(Demo)).length > 0,
      }).toStrictEqual({ name, rendered: true });
    }
  });
});
