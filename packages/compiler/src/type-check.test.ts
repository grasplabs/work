import { describe, expect, it } from "vite-plus/test";

import { screenTarget, typeCheck } from "./type-check.ts";

// What an App file's types may resolve to, on their own: the type check
// is pure (in memory), so tested in isolation, against a kit of two
// packages, one the App is given and one it isn't. Whatever syntax names
// a module, here an import inside an ambient module, which no import
// check collects, resolution alone decides.

const kitTypes = {
  "/node_modules/given/package.json":
    '{ "name": "given", "types": "index.d.ts" }',
  "/node_modules/given/index.d.ts": "export type Given = 1;\n",
  "/node_modules/hidden/package.json":
    '{ "name": "hidden", "types": "index.d.ts" }',
  "/node_modules/hidden/index.d.ts": "export type Hidden = 2;\n",
};

const appFiles = {
  "probe.d.ts": `declare module "probe" {
  import type { Hidden } from "hidden";
  import type { Given } from "given";
  export type Reached = [Hidden, Given];
}
`,
  // A path into the kit's packages, which an ambient module can't name.
  "by-path.ts": `import type { Hidden } from "./node_modules/hidden/index";
export type ByPath = Hidden;
`,
};

/** The modules the check couldn't resolve for the App, by name. */
const unresolved = (allowed?: ReadonlySet<string>): string[] =>
  typeCheck(
    appFiles,
    kitTypes,
    allowed === undefined ? undefined : screenTarget(allowed)
  )
    .filter(
      ({ rule, file }) =>
        rule === "TS2307" && (file === "probe.d.ts" || file === "by-path.ts")
    )
    .map(
      ({ message }) =>
        /'(?<module>[^']+)'/u.exec(message)?.groups?.module ?? message
    )
    .toSorted();

describe("what an App file's types resolve to", () => {
  it("is only the App's files and the modules it is given, by name", () => {
    expect({
      given: unresolved(new Set(["given"])),
      // Without the bound, TypeScript resolves all of it.
      unbounded: unresolved(),
    }).toStrictEqual({
      given: ["./node_modules/hidden/index", "hidden"],
      unbounded: [],
    });
  });
});
