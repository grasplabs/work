import { describe, expect, it } from "vite-plus/test";

import { lookalikeOf, oneEditApart } from "../src/packages/lookalikes.ts";

// Lookalike package names (src/packages/lookalikes.ts): pure logic, so
// tested on its own. What each name is taken for, or not.

/** What `name` is taken for, as the test reads it. */
const shown = (name: string): string | null => {
  const like = lookalikeOf(name);
  if (like === undefined) {
    return null;
  }
  return like.scope === undefined ? like.of : `${like.of}, under ${like.scope}`;
};

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
          "@evil/lodahs",
          "Lodash",
          "lodash",
          "react-dom",
          "lodash-es",
          "qz",
          "rect",
          "core",
          "@types/reakt",
          "left-pad",
          "@types/lodash",
          "@types/lodahs",
          // Squat forms: `js` off the end, `node` off the start.
          "lodashjs",
          "lodash.js",
          "axios-js",
          "node-lodash",
          "nodeexpress-js",
          // Real packages, scoped after what they serve.
          "@emotion/react",
          "@testing-library/react",
          "@sentry/react",
          "@base-ui-components/react",
          "@octokit/request",
          "@octokit/graphql",
          "@nestjs/graphql",
          "@nestjs/axios",
          // Real packages of their own, one edit from popular ones.
          "@protobufjs/inquire",
          "preact",
          "color",
          "colord",
          "tslint",
          "reach",
        ].map((name) => [name, shown(name)])
      )
    ).toStrictEqual({
      loadsh: "lodash",
      expresss: "express",
      reactdom: "react-dom",
      react_dom: "react-dom",
      "@evil/lodash": "lodash, under @evil",
      "@evil/lodahs": "lodash",
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
      // DefinitelyTyped names its packages after what they type.
      "@types/lodash": null,
      "@types/lodahs": null,
      lodashjs: "lodash",
      "lodash.js": "lodash",
      "axios-js": "axios",
      "node-lodash": "lodash",
      "nodeexpress-js": "express",
      "@emotion/react": "react, under @emotion",
      "@testing-library/react": "react, under @testing-library",
      "@sentry/react": "react, under @sentry",
      "@base-ui-components/react": "react, under @base-ui-components",
      "@octokit/request": "request, under @octokit",
      "@octokit/graphql": "graphql, under @octokit",
      "@nestjs/graphql": "graphql, under @nestjs",
      "@nestjs/axios": "axios, under @nestjs",
      "@protobufjs/inquire": null,
      preact: null,
      color: null,
      colord: null,
      tslint: null,
      reach: null,
    });
  });
});
