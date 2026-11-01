import { readdirSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { demos } from "../catalog/demos.ts";
import { loadExample } from "../catalog/examples.ts";

// The dev-only gallery (apps/web, `/kit`) against what the kit really
// ships: screens import `@grasp-os/ui/components/<name>`, one module per
// file of the components directory, and each has a demo there; each file
// of the examples directory loads by its name.

/** The names of the `.tsx` modules in `dir`, tests aside. */
const modulesIn = (dir: string): string[] =>
  readdirSync(path.join(import.meta.dirname, dir))
    .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))
    .map((file) => file.slice(0, -".tsx".length))
    .toSorted();

describe("the kit's demos", () => {
  it("has a demo of every component in the kit, and each renders (a smoke test)", () => {
    expect(Object.keys(demos).toSorted()).toStrictEqual(
      modulesIn("../src/components")
    );
    for (const [name, Demo] of Object.entries(demos)) {
      expect({
        name,
        rendered: renderToStaticMarkup(createElement(Demo)).length > 0,
      }).toStrictEqual({ name, rendered: true });
    }
  });
});

describe("the kit's examples", () => {
  it("loads each example file by its name, and it renders (a smoke test)", async () => {
    expect(Object.keys(loadExample).toSorted()).toStrictEqual(
      modulesIn("../catalog/examples")
    );
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
