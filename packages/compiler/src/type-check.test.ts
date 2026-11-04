import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vite-plus/test";

import {
  diagnosticsOfRun,
  screenTarget,
  typeCheck,
  typeCheckRequest,
} from "./type-check.ts";
import type { KitTypes, TypeTarget } from "./type-check.ts";

// The type check on its own: tsrs's WebAssembly, run in memory over a kit
// of two packages, one the App is given and one it isn't. Whatever syntax
// names a module, here an import inside an ambient module, which no import
// check collects, resolution alone decides. Builds hold every App file to
// it through the checker's isolate (apps/core/test/type-check-parity.test.ts).

// Made as Node makes a module; the Workers types this package is checked
// with type the class as one only the runtime makes.
const made: unknown = Reflect.construct(WebAssembly.Module, [
  readFileSync(createRequire(import.meta.url).resolve("@tsrs/wasm/tsrs.wasm")),
]);
if (!(made instanceof WebAssembly.Module)) {
  throw new TypeError("tsrs's WebAssembly didn't compile");
}
const tsrs = made;

const kit: KitTypes = {
  files: {
    "/node_modules/given/package.json":
      '{ "name": "given", "types": "index.d.ts" }',
    "/node_modules/given/index.d.ts":
      'import type { Hidden } from "hidden";\nexport type Given = 1;\nexport type Through = Hidden;\n',
    "/node_modules/hidden/package.json":
      '{ "name": "hidden", "types": "index.d.ts" }',
    // An error of the kit's own, which never counts.
    "/node_modules/hidden/index.d.ts":
      "export type Hidden = 2;\nexport const broken: Missing;\n",
  },
  resolved: {
    given: "/node_modules/given/index.d.ts",
    hidden: "/node_modules/hidden/index.d.ts",
  },
};

const given = screenTarget(new Set(["given"]));

/** `files` checked for `target`, as `file:line:column rule`. */
const checked = (
  files: Record<string, string>,
  target?: TypeTarget
): string[] =>
  typeCheck(tsrs, kit, typeCheckRequest(files, target)).map(
    ({ file, line, column, rule }) =>
      `${file ?? "(App)"}:${line ?? 0}:${column ?? 0} ${rule}`
  );

const reaching = {
  "probe.d.ts": `declare module "probe" {
  import type { Hidden } from "hidden";
  import type { Given } from "given";
  export type Reached = [Hidden, Given];
}
`,
  "in-namespace.d.ts": `declare namespace Probe {
  type Hidden = typeof import("hidden");
}
`,
  // Paths into the kit's packages, where a check that resolves any of
  // them has them, and where one that resolves only some hides them.
  "by-path.ts": `import type { Hidden } from "./node_modules/hidden/index";
export type ByPath = Hidden;
`,
  "by-hidden-path.ts": `import type { Hidden } from "./.kit/node_modules/hidden/index";
export type ByHiddenPath = Hidden;
`,
  "by-bare-path.ts": `import type { Hidden } from ".kit/node_modules/hidden/index";
export type ByBarePath = Hidden;
`,
};

describe("what an App file's types resolve to", () => {
  it("is only the App's files and the modules it is given, by name, where its kit's own files resolve what they import", () => {
    expect({
      // A relative path to where the check hides the kit resolves: each
      // file's compile refuses a type's path that isn't an App file
      // (imports.ts `typeFileError`, `screenTypeImportError`), and a
      // compile error fails the build whatever the check says.
      given: checked(reaching, given),
      // Without the bound, TypeScript resolves all of the kit by name and
      // by path; never what is no file.
      unbounded: checked(reaching),
    }).toStrictEqual({
      given: [
        "by-bare-path.ts:1:29 TS2307",
        "by-path.ts:1:29 TS2307",
        "in-namespace.d.ts:2:31 TS2307",
        "probe.d.ts:2:31 TS2307",
      ],
      unbounded: [
        "by-bare-path.ts:1:29 TS2307",
        "by-hidden-path.ts:1:29 TS2307",
      ],
    });
  });

  it("reads a module it is given through the kit's own files, which resolve what it isn't", () => {
    expect(
      checked(
        {
          "uses.ts":
            'import type { Through } from "given";\nexport const wrong: Through = 3;\n',
        },
        given
      )
    ).toStrictEqual(["uses.ts:2:14 TS2322"]);
  });
});

describe("what a check counts", () => {
  it("is the App's files' diagnostics, its declarations' among them, never the kit's", () => {
    expect({
      // The kit's own error, with an App declaration file and without.
      withDeclarations: checked(
        { "types.d.ts": "export interface Wrong {\n  field: Absent;\n}\n" },
        given
      ),
      without: checked({ "fine.ts": "export const fine = 1;\n" }, given),
    }).toStrictEqual({
      withDeclarations: ["types.d.ts:2:10 TS2304"],
      without: [],
    });
  });

  it("locates a diagnostic by UTF-16 column, as an editor does", () => {
    expect(
      checked({
        "face.ts": 'const face = "😀😀"; export const n: number = face;\n',
      })
    ).toStrictEqual(["face.ts:1:35 TS2322"]);
  });

  it("says a diagnostic's whole chain, and names the kit's modules where they were before it hid them", () => {
    const [diagnostic] = typeCheck(
      tsrs,
      kit,
      typeCheckRequest(
        {
          "chain.ts":
            'import * as given from "given";\nexport const wrong: { a: { b: string } } = { a: { b: 1 } };\nexport const named: number = given;\n',
        },
        given
      )
    );
    expect(diagnostic?.message).toBe(
      "Type 'number' is not assignable to type 'string'."
    );
    expect(
      typeCheck(
        tsrs,
        kit,
        typeCheckRequest(
          {
            "named.ts":
              'import * as given from "given";\nexport const named: number = given;\n',
          },
          given
        )
      ).map(({ message }) => message)
    ).toStrictEqual([
      `Type 'typeof import("/node_modules/given/index")' is not assignable to type 'number'.`,
    ]);
  });

  it("fails on the program's own errors, its options' among them", () => {
    expect(
      typeCheck(tsrs, kit, {
        files: { "fine.ts": "export const fine = 1;\n" },
        options: { ...given.options, strict: "yes" },
      }).map(({ file, rule, severity }) => ({ file, rule, severity }))
    ).toStrictEqual([{ file: undefined, rule: "TS5024", severity: "error" }]);
  });

  it("refuses to read anything but the App's TypeScript, never a file where the kit or its own settings go", () => {
    const strays: Record<string, string>[] = [
      { "node_modules/given/index.d.ts": "export type Given = 2;\n" },
      { ".kit/node_modules/given/index.d.ts": "export type Given = 2;\n" },
      { "tsconfig.json": "{}" },
      { "/absolute.ts": "export {};\n" },
    ];
    expect(
      strays.map((files) =>
        typeCheck(tsrs, kit, typeCheckRequest(files, given)).map(
          ({ rule, severity }) => `${rule} ${severity}`
        )
      )
    ).toStrictEqual([
      ["check error"],
      ["check error"],
      ["check error"],
      ["check error"],
    ]);
  });
});

/** What reading a run of `exitCode` that replied `diagnostics` says, as `rule severity`. */
const read = (exitCode: number, diagnostics?: unknown[]): string[] =>
  diagnosticsOfRun(
    {
      exitCode,
      reply:
        diagnostics === undefined
          ? new Uint8Array()
          : new TextEncoder().encode(JSON.stringify(diagnostics)),
      stderr: "",
    },
    { files: { "a.ts": "" }, root: "/.kit/node_modules/" }
  ).map(({ rule, severity }) => `${rule} ${severity}`);

describe("a run of tsc", () => {
  const kitError = {
    fileName: "/.kit/node_modules/hidden/index.d.ts",
    pos: 0,
    end: 1,
    code: 2304,
    category: 1,
    text: "Cannot find name 'Missing'.",
  };

  it("passes only a clean exit, or a failure some error explains, the kit's included", () => {
    expect({
      clean: read(0),
      failedEmpty: read(1),
      failedWarned: read(2, [{ ...kitError, category: 0 }]),
      failedOnTheKit: read(2, [kitError]),
      crashed: read(5),
      invalidProject: read(3, [kitError]),
      unreadable: diagnosticsOfRun(
        { exitCode: 0, reply: new TextEncoder().encode("{"), stderr: "" },
        { files: {}, root: "/.kit/node_modules/" }
      ).map(({ rule, severity }) => `${rule} ${severity}`),
    }).toStrictEqual({
      clean: [],
      failedEmpty: ["check error"],
      failedWarned: ["check error"],
      // The kit's own error is never the App's; the failure has its cause.
      failedOnTheKit: [],
      crashed: ["check error"],
      invalidProject: ["check error"],
      unreadable: ["check error"],
    });
  });
});

describe("unused names in App code", () => {
  it("are errors in what the agent writes, but for parameters (a handler's `ctx` it doesn't read), and never in what the host generates", () => {
    const found = typeCheck(
      tsrs,
      kit,
      typeCheckRequest(
        {
          "components/total.ts": `import type { Given } from "given";

export const total = (ctx: number, row: number): number => {
  void row;
  const left = 1;
  return 2;
};
`,
          "server/_generated/api.ts": "const spare = 1;\nexport {};\n",
        },
        given
      )
    )
      .filter(({ rule }) => ["TS6133", "TS6192", "TS6196"].includes(rule))
      .map(({ file, line, rule }) => ({ file, line, rule }));

    expect(found).toStrictEqual([
      // TypeScript 7 says an unused type is unused as a type.
      { file: "components/total.ts", line: 1, rule: "TS6196" },
      { file: "components/total.ts", line: 5, rule: "TS6133" },
    ]);
  });
});
