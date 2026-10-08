import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { resolveImports, resolveSubpath } from "./exports.ts";

// `exports` and `imports` checked against Node's own resolver: every case
// is resolved by real Node (`import.meta.resolve` under `--conditions`)
// over packages on disk, and by exports.ts, and both must give what the
// table says. Where Node and the table disagree, Node is right.
// `import.meta.resolve` doesn't check that the file is there (the import
// would fail), so a file that isn't counts as nothing resolved.

/** The conditions Node's ESM resolver always has, besides `--conditions`. */
const nodeConditions = ["node", "import", "module-sync", "node-addons"];

interface Case {
  name: string;
  manifest: Record<string, unknown>;
  files: string[];
  /** `.`, `./sub` or `#name`. */
  ask: string;
  conditions?: string[];
  /** The package's file, `bare:<name>` for a dependency, or null. */
  expected: string | null;
}

const cases: Case[] = [
  {
    name: "a longer pattern key wins over a shorter one with the same prefix",
    manifest: { exports: { "./*": "./lib/*.js", "./*.js": "./raw/*.js" } },
    files: ["lib/a.js", "raw/b.js"],
    ask: "./b.js",
    expected: "raw/b.js",
  },
  {
    name: "a pattern without the longer key's trailer",
    manifest: { exports: { "./*": "./lib/*.js", "./*.js": "./raw/*.js" } },
    files: ["lib/a.js", "raw/b.js"],
    ask: "./a",
    expected: "lib/a.js",
  },
  {
    name: "a pattern's trailer must match",
    manifest: { exports: { "./features/*.js": "./src/*.js" } },
    files: ["src/x.js"],
    ask: "./features/x",
    expected: null,
  },
  {
    name: "a pattern with a trailer",
    manifest: { exports: { "./features/*.js": "./src/*.js" } },
    files: ["src/x.js"],
    ask: "./features/x.js",
    expected: "src/x.js",
  },
  {
    name: "a null in an array is skipped",
    manifest: { exports: { ".": [null, "./index.js"] } },
    files: ["index.js"],
    ask: ".",
    expected: "index.js",
  },
  {
    name: "a null alone blocks the export",
    manifest: { exports: { ".": null, "./index.js": "./index.js" } },
    files: ["index.js"],
    ask: ".",
    expected: null,
  },
  {
    name: "an invalid target in an array is skipped",
    manifest: { exports: { ".": ["../outside.js", "./index.js"] } },
    files: ["index.js"],
    ask: ".",
    expected: "index.js",
  },
  {
    name: "an empty array exports nothing",
    manifest: { exports: { ".": [] } },
    files: ["index.js"],
    ask: ".",
    expected: null,
  },
  {
    // Node's array gives undefined (not null) when no element matched, so
    // the condition after it is tried.
    name: "an array whose conditions all go unmatched, before a default",
    manifest: {
      exports: {
        ".": { import: [{ development: "./dev.js" }], default: "./main.js" },
      },
    },
    files: ["dev.js", "main.js"],
    ask: ".",
    expected: "main.js",
  },
  {
    name: "an array whose conditions all go unmatched, alone",
    manifest: { exports: { ".": [{ development: "./dev.js" }] } },
    files: ["dev.js"],
    ask: ".",
    expected: null,
  },
  {
    name: "conditions in the package's order, not the resolver's",
    manifest: { exports: { ".": { default: "./a.js", custom: "./b.js" } } },
    files: ["a.js", "b.js"],
    ask: ".",
    conditions: ["custom"],
    expected: "a.js",
  },
  {
    name: "a matched condition",
    manifest: { exports: { ".": { custom: "./b.js", default: "./a.js" } } },
    files: ["a.js", "b.js"],
    ask: ".",
    conditions: ["custom"],
    expected: "b.js",
  },
  {
    name: "an array index as a condition is an invalid configuration",
    manifest: { exports: { ".": { 0: "./a.js", default: "./b.js" } } },
    files: ["a.js", "b.js"],
    ask: ".",
    expected: null,
  },
  {
    name: "a leading zero isn't an array index",
    manifest: { exports: { ".": { "01": "./a.js", default: "./b.js" } } },
    files: ["a.js", "b.js"],
    ask: ".",
    conditions: ["01"],
    expected: "a.js",
  },
  {
    name: "2^32 - 1 isn't an array index",
    manifest: {
      exports: { ".": { 4_294_967_295: "./a.js", default: "./b.js" } },
    },
    files: ["a.js", "b.js"],
    ask: ".",
    conditions: ["4294967295"],
    expected: "a.js",
  },
  {
    name: "sugar: a string is the main export",
    manifest: { exports: "./index.js" },
    files: ["index.js"],
    ask: ".",
    expected: "index.js",
  },
  {
    name: "sugar exports nothing else",
    manifest: { exports: "./index.js" },
    files: ["index.js", "other.js"],
    ask: "./other.js",
    expected: null,
  },
  {
    name: "subpaths and conditions mixed are an invalid configuration",
    manifest: { exports: { ".": "./a.js", import: "./b.js" } },
    files: ["a.js", "b.js"],
    ask: ".",
    expected: null,
  },
  {
    name: "a target out of the package",
    manifest: { exports: { ".": "../outside.js" } },
    files: [],
    ask: ".",
    expected: null,
  },
  {
    name: "a target through node_modules",
    manifest: { exports: { ".": "./node_modules/x/index.js" } },
    files: ["node_modules/x/index.js"],
    ask: ".",
    expected: null,
  },
  {
    name: "a pattern's match with ..",
    manifest: { exports: { "./*": "./lib/*" } },
    files: ["secret.js", "lib/a.js"],
    ask: "./x/../../secret.js",
    expected: null,
  },
  {
    name: "a target as written, without extensions",
    manifest: { exports: { ".": "./index" } },
    files: ["index.js"],
    ask: ".",
    expected: null,
  },
  {
    name: "an imports target in the package",
    manifest: { imports: { "#x": "./x.js" } },
    files: ["x.js"],
    ask: "#x",
    expected: "x.js",
  },
  {
    name: "an imports target that is a package",
    manifest: { imports: { "#helper": "helper" } },
    files: [],
    ask: "#helper",
    expected: "bare:helper",
  },
  {
    name: "an imports pattern to a package's subpath",
    manifest: { imports: { "#h/*": "helper/*" } },
    files: [],
    ask: "#h/extra.js",
    expected: "bare:helper",
  },
  {
    name: "an imports target that is a URL",
    manifest: { imports: { "#u": "https://x.example/a.js" } },
    files: [],
    ask: "#u",
    expected: null,
  },
  {
    name: "an imports name that isn't mapped",
    manifest: { imports: { "#x": "./x.js" } },
    files: ["x.js"],
    ask: "#y",
    expected: null,
  },
  {
    name: "an imports null blocks the name",
    manifest: { imports: { "#x": null } },
    files: ["x.js"],
    ask: "#x",
    expected: null,
  },
  {
    name: "an array of an invalid target then a null",
    manifest: { exports: { ".": ["../outside.js", null] } },
    files: [],
    ask: ".",
    expected: null,
  },
  {
    name: "a percent-encoded node_modules in a pattern's match",
    manifest: { exports: { "./*": "./*" } },
    files: ["node_modules/x.js", "a.js"],
    ask: "./node%5Fmodules/x.js",
    expected: null,
  },
  {
    name: "an exact key wins over a pattern",
    manifest: { exports: { "./a.js": "./exact.js", "./*": "./lib/*" } },
    files: ["exact.js", "lib/a.js"],
    ask: "./a.js",
    expected: "exact.js",
  },
  {
    name: "a pattern never matches the main export",
    manifest: { exports: { "./*": "./lib/*.js" } },
    files: ["lib/.js"],
    ask: ".",
    expected: null,
  },
  {
    name: "an imports name of only #",
    manifest: { imports: { "#": "./x.js" } },
    files: ["x.js"],
    ask: "#",
    expected: null,
  },
  {
    name: "an imports name ending in /",
    manifest: { imports: { "#x/": "./x/" } },
    files: ["x/index.js"],
    ask: "#x/",
    expected: null,
  },
  {
    name: "imports conditions",
    manifest: {
      imports: { "#x": { custom: "./custom.js", default: "./x.js" } },
    },
    files: ["x.js", "custom.js"],
    ask: "#x",
    conditions: ["custom"],
    expected: "custom.js",
  },
];

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "grasp-exports-")));

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const packageName = (index: number): string => `pkg-${index}`;

// The packages, a dependency `#helper` names, and a probe in each that
// resolves `#` names from inside it.
for (const [index, { manifest, files }] of cases.entries()) {
  const directory = path.join(root, "node_modules", packageName(index));
  write(
    path.join(directory, "package.json"),
    JSON.stringify({ name: packageName(index), type: "module", ...manifest })
  );
  for (const file of files) {
    write(path.join(directory, file), "export {};");
  }
  write(
    path.join(directory, "probe.mjs"),
    "export const resolve = (specifier) => import.meta.resolve(specifier);"
  );
}
write(
  path.join(root, "node_modules", "helper", "package.json"),
  JSON.stringify({ name: "helper", type: "module", main: "index.js" })
);
write(path.join(root, "node_modules", "helper", "index.js"), "export {};");
write(path.join(root, "node_modules", "helper", "extra.js"), "export {};");
write(
  path.join(root, "resolve.mjs"),
  `import { pathToFileURL } from "node:url";
const asked = JSON.parse(process.argv[2]);
const results = {};
for (const { index, ask } of asked) {
  const name = "pkg-" + index;
  try {
    if (ask.startsWith("#")) {
      const probe = await import(pathToFileURL(${JSON.stringify(root)} + "/node_modules/" + name + "/probe.mjs").href);
      results[index] = probe.resolve(ask);
    } else {
      results[index] = import.meta.resolve(ask === "." ? name : name + ask.slice(1));
    }
  } catch {
    results[index] = null;
  }
}
process.stdout.write(JSON.stringify(results));`
);

/** What Node resolves each case to, in the table's terms. */
const nodeResults = (): Map<number, string | null> => {
  const groups = new Map<string, number[]>();
  for (const [index, { conditions = [] }] of cases.entries()) {
    const key = conditions.join("\n");
    groups.set(key, [...(groups.get(key) ?? []), index]);
  }
  const results = new Map<number, string | null>();
  for (const [key, indexes] of groups) {
    const conditions = key === "" ? [] : key.split("\n");
    const output = execFileSync(
      process.execPath,
      [
        ...conditions.map((condition) => `--conditions=${condition}`),
        path.join(root, "resolve.mjs"),
        JSON.stringify(
          indexes.map((index) => ({ index, ask: cases[index]?.ask }))
        ),
      ],
      { encoding: "utf-8" }
    );
    const resolved = z
      .record(z.string(), z.string().nullable())
      .parse(JSON.parse(output));
    for (const index of indexes) {
      const url = resolved[index] ?? null;
      const own = `${root}/node_modules/${packageName(index)}/`;
      const file = url === null ? null : new URL(url).pathname;
      if (file === null || !existsSync(file)) {
        results.set(index, null);
      } else if (file.startsWith(own)) {
        results.set(index, file.slice(own.length));
      } else {
        results.set(
          index,
          file.includes("/node_modules/helper/") ? "bare:helper" : file
        );
      }
    }
  }
  return results;
};

/** What exports.ts resolves a case to, in the table's terms. */
const ours = ({
  manifest,
  files,
  ask,
  conditions = [],
}: Case): string | null => {
  const pkg = {
    manifest,
    files: new Map(files.map((file) => [file, new Uint8Array()])),
  };
  const all = [...nodeConditions, ...conditions];
  if (ask.startsWith("#")) {
    const target = resolveImports(pkg, ask, all);
    if (target === undefined) {
      return null;
    }
    return target.kind === "file"
      ? target.path
      : `bare:${target.specifier.split("/")[0]}`;
  }
  return resolveSubpath(pkg, ask, all, false) ?? null;
};

describe("exports and imports, as Node resolves them", () => {
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolve every case as real Node does", () => {
    const node = nodeResults();
    const table = Object.fromEntries(
      cases.map(({ name, expected }) => [name, expected])
    );
    expect({
      node: Object.fromEntries(
        cases.map(({ name }, index) => [name, node.get(index) ?? null])
      ),
      ours: Object.fromEntries(cases.map((each) => [each.name, ours(each)])),
    }).toStrictEqual({ node: table, ours: table });
  });
});
