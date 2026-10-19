import { describe, expect, it } from "vite-plus/test";

import { lookalikeOf, oneEditApart } from "../src/packages/lookalikes.ts";

// Lookalike package names (src/packages/lookalikes.ts): pure logic, so
// tested on its own. What each name is taken for, or not.

describe("lookalike package names", () => {
  it("counts one edit apart: a letter inserted, deleted, replaced, or two adjacent swapped", () => {
    expect(
      [
        ["express", "express"],
        ["express", "expresss"],
        ["express", "expres"],
        ["express", "exprets"],
        ["lodash", "lodahs"],
        ["lodash", "loadsh"],
        ["express", "exprssse"],
        ["lodash", "ldoahs"],
        ["react", "raect-x"],
      ].map(([a = "", b = ""]) => oneEditApart(a, b))
    ).toStrictEqual([true, true, true, true, true, true, false, false, false]);
  });

  it("takes a name for the popular one it looks like, never a popular name itself or a short name's neighbour", () => {
    expect(
      Object.fromEntries(
        [
          "loadsh",
          "expresss",
          "reactdom",
          "react_dom",
          "@evil/lodash",
          "Lodash",
          "lodash",
          "react-dom",
          "lodash-es",
          "qz",
          "rect",
          "core",
          "@types/reakt",
          "left-pad",
        ].map((name) => [name, lookalikeOf(name) ?? null])
      )
    ).toStrictEqual({
      loadsh: "lodash",
      expresss: "express",
      reactdom: "react-dom",
      react_dom: "react-dom",
      "@evil/lodash": "lodash",
      Lodash: "lodash",
      lodash: null,
      "react-dom": null,
      "lodash-es": null,
      qz: null,
      rect: "react",
      // `@babel/core` keeps its scope: a package named `core` is its own.
      core: null,
      "@types/reakt": "@types/react",
      "left-pad": null,
    });
  });
});
