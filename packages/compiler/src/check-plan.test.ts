import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vite-plus/test";

import { graphOf } from "./check-graph.ts";
import {
  checkBatches,
  checkedDiagnostics,
  checkKeys,
  checkRecords,
} from "./check-plan.ts";
import type { Diagnostic } from "./diagnostic.ts";
import type { CheckRecord } from "./increments.ts";
import { compilerOptions, typeCheck, typeCheckRequest } from "./type-check.ts";
import type { TypeTarget } from "./type-check.ts";

// The check a part at a time, as core runs it for an App too large for
// one run (pages.ts `typeChecked`), against one tsrs run over the whole
// App, with tsrs's WebAssembly in memory: after each edit it says exactly
// what the whole check says, and checks the edited files and none but
// those that may see them. Most edits reach files that don't import what
// changed: through a global, an augmentation, a re-export or a mapped
// name. Parts are sized small, so every check runs in several. Builds
// hold every App to it through the checker's isolate
// (apps/core/test/type-check-parity.test.ts), and the release's checker
// with the kit's types (build-heap.test.ts).

// Made as Node makes a module; the Workers types this package is checked
// with type the class as one only the runtime makes.
const made: unknown = Reflect.construct(WebAssembly.Module, [
  readFileSync(createRequire(import.meta.url).resolve("@tsrs/wasm/tsrs.wasm")),
]);
if (!(made instanceof WebAssembly.Module)) {
  throw new TypeError("tsrs's WebAssembly didn't compile");
}
const tsrs = made;

const kit = { files: {}, resolved: {} };

/** The pages' options, with a generated module mapped by name, as server code maps its own. */
const target: TypeTarget = {
  options: {
    ...compilerOptions,
    paths: { "@server/_generated/api": ["./server/_generated/api.ts"] },
  },
  mapped: new Set(["@server/_generated/api"]),
};

/** Each diagnostic as one line: what a check said. */
const said = (diagnostics: readonly Diagnostic[]): string[] =>
  diagnostics
    .map(
      ({ file, line, column, rule, message }) =>
        `${file ?? "(App)"}:${line ?? 0}:${column ?? 0} ${rule} ${message}`
    )
    .toSorted();

/** One run over every file. */
const whole = (files: Record<string, string>): string[] =>
  said(typeCheck(tsrs, kit, typeCheckRequest(files, target)));

/**
 * A check of `files` a part at a time, reusing what `kept` holds by key
 * and keeping what it checks there: what it said, and which files it
 * checked.
 */
const inParts = async (
  files: Record<string, string>,
  kept: Map<string, CheckRecord>
): Promise<{ said: string[]; checked: string[] }> => {
  const request = typeCheckRequest(files, target);
  const { keys, closures } = await checkKeys(request, graphOf(files, "auto"));
  const records = new Map<string, CheckRecord>();
  for (const [path, key] of Object.entries(keys ?? {})) {
    const record = kept.get(key);
    if (record !== undefined) {
      records.set(path, record);
    }
  }
  const due = Object.keys(files).filter((path) => !records.has(path));
  for (const part of checkBatches(request, closures, due, 400)) {
    const diagnostics = typeCheck(tsrs, kit, part);
    for (const record of checkRecords(Object.keys(part.files), diagnostics)) {
      const key = keys?.[record.path];
      if (!records.has(record.path)) {
        records.set(record.path, record);
        if (key !== undefined) {
          kept.set(key, record);
        }
      }
    }
  }
  return {
    said: said(checkedDiagnostics(Object.keys(files), records)),
    checked: due,
  };
};

const app: Record<string, string> = {
  "money.d.ts": "type Money = number;\n",
  "lib/math.ts":
    "export const add = (a: Money, b: Money): Money => a + b;\nexport interface Row { id: string; total: Money }\n",
  "lib/format.ts":
    'import { add } from "./math";\nimport type { Row } from "./math";\n\nexport const label = (row: Row): string => row.id + String(add(row.total, 1));\n',
  "lib/inner.ts": "export const inner = 1;\n",
  "lib/barrel.ts": 'export * from "./inner";\n',
  "lib/x.ts":
    'import type { Y } from "./y";\n\nexport interface X { n: number; y?: Y }\n',
  "lib/y.ts": 'import type { X } from "./x";\n\nexport interface Y { x?: X }\n',
  // A script: `import T = NS.T` names no module, so this declares globals.
  "lib/errors.ts":
    "declare namespace NS {\n  type T = string;\n}\nimport T = NS.T;\ntype Code = T;\n",
  "server/_generated/api.ts": "export const api = { count: 1 };\n",
  "pages/a.ts":
    'import { label } from "../lib/format";\n\nexport const a: string = label({ id: "a", total: 1 });\n',
  "pages/b.ts":
    'import { add } from "../lib/math.js";\n\nexport const b: number = add(1, 2);\n',
  "pages/c.ts": "export const c: Money = 3;\n",
  "pages/d.ts":
    'import { inner } from "../lib/barrel";\n\nexport const d: number = inner;\n',
  "pages/e.ts":
    'import type { X } from "../lib/x";\n\nexport const e: X = { n: 1, y: {} };\n',
  "pages/f.ts":
    'import { api } from "@server/_generated/api";\n\nexport const f: number = api.count;\n',
  "pages/g.ts": 'export const g: Error = { name: "a", message: "b" };\n',
  "pages/broken.ts":
    'import { missing } from "../lib/missing";\n\nexport const m: string = missing;\n',
};

const all = Object.keys(app);

/**
 * Each edit of `app`, one after another, each built on what the checks
 * before it kept: the files it changes, which its check must include, and
 * those that may see them, which bound what it checks.
 */
const edits: {
  edit: string;
  files: Record<string, string>;
  changed: string[];
  reach: string[];
}[] = [
  { edit: "first", files: app, changed: all, reach: all },
  { edit: "unchanged", files: app, changed: [], reach: [] },
  {
    edit: "a type changes shape",
    files: {
      ...app,
      "lib/math.ts":
        "export const add = (a: Money, b: Money): string => String(a + b);\nexport interface Row { id: string; total: Money }\n",
    },
    changed: ["lib/math.ts"],
    reach: ["lib/math.ts", "lib/format.ts", "pages/a.ts", "pages/b.ts"],
  },
  {
    edit: "an export renamed",
    files: {
      ...app,
      "lib/format.ts":
        'import { add } from "./math";\nimport type { Row } from "./math";\n\nexport const labelOf = (row: Row): string => row.id + String(add(row.total, 1));\n',
    },
    changed: ["lib/format.ts"],
    reach: ["lib/format.ts", "pages/a.ts"],
  },
  {
    edit: "a file deleted",
    files: Object.fromEntries(
      Object.entries(app).filter(([path]) => path !== "lib/math.ts")
    ),
    changed: [],
    reach: ["lib/format.ts", "pages/a.ts", "pages/b.ts"],
  },
  {
    edit: "the file a broken import names added",
    files: { ...app, "lib/missing.ts": 'export const missing = "here";\n' },
    changed: ["lib/missing.ts", "pages/broken.ts"],
    reach: ["lib/missing.ts", "pages/broken.ts"],
  },
  {
    edit: "a declaration file's global changed",
    files: { ...app, "money.d.ts": "type Money = string;\n" },
    changed: all,
    reach: all,
  },
  {
    edit: "a module augmented by a file nothing imports",
    files: {
      ...app,
      "lib/augment.ts":
        'import "./math";\n\ndeclare module "./math" {\n  interface Row {\n    extra: number;\n  }\n}\n',
    },
    changed: all,
    reach: [...all, "lib/augment.ts"],
  },
  {
    edit: "declare global in a module",
    files: {
      ...app,
      "lib/global.ts":
        "export {};\n\ndeclare global {\n  interface Error {\n    code: number;\n  }\n}\n",
    },
    changed: all,
    reach: [...all, "lib/global.ts"],
  },
  {
    edit: "a script added",
    files: {
      ...app,
      "lib/script.ts": "interface Error {\n  code: number;\n}\n",
    },
    changed: all,
    reach: [...all, "lib/script.ts"],
  },
  {
    edit: "a global declared in a script with an import alias",
    files: {
      ...app,
      "lib/errors.ts": `${app["lib/errors.ts"] ?? ""}interface Error {\n  code: Code;\n}\n`,
    },
    changed: all,
    reach: all,
  },
  {
    edit: "a reference path added",
    files: {
      ...app,
      "pages/c.ts": `/// <reference path="../lib/math.ts" />\n${app["pages/c.ts"] ?? ""}`,
    },
    changed: all,
    reach: all,
  },
  {
    edit: "a generated module mapped by name changed",
    files: {
      ...app,
      "server/_generated/api.ts": 'export const api = { count: "1" };\n',
    },
    changed: ["server/_generated/api.ts"],
    reach: ["server/_generated/api.ts", "pages/f.ts"],
  },
  {
    edit: "a module re-exported with export * changed",
    files: { ...app, "lib/inner.ts": 'export const inner = "1";\n' },
    changed: ["lib/inner.ts"],
    reach: ["lib/inner.ts", "lib/barrel.ts", "pages/d.ts"],
  },
  {
    edit: "a type in an import type cycle changed",
    files: {
      ...app,
      "lib/y.ts":
        'import type { X } from "./x";\n\nexport interface Y { x?: X; must: string }\n',
    },
    changed: ["lib/y.ts"],
    reach: ["lib/x.ts", "lib/y.ts", "pages/e.ts"],
  },
  // Its references unknown, every file is checked, and none kept.
  {
    edit: "a file that doesn't parse",
    files: { ...app, "pages/c.ts": "export const c: Money = ;\n" },
    changed: all,
    reach: all,
  },
];

describe("the type check, a part at a time", { timeout: 60_000 }, () => {
  it("says after each edit what one check of the whole App says, checking the edited files and none the edit can't reach", async () => {
    const kept = new Map<string, CheckRecord>();
    const checks: {
      edit: string;
      said: string[];
      missed: string[];
      beyond: string[];
    }[] = [];
    for (const { edit, files, changed, reach } of edits) {
      // oxlint-disable-next-line no-await-in-loop -- each edit after the last, as builds come
      const { said: what, checked } = await inParts(files, kept);
      checks.push({
        edit,
        said: what,
        missed: changed.filter((path) => !checked.includes(path)),
        beyond: checked.filter((path) => !reach.includes(path)),
      });
    }
    expect(checks).toStrictEqual(
      edits.map(({ edit, files }) => ({
        edit,
        said: whole(files),
        missed: [],
        beyond: [],
      }))
    );
  });
});
