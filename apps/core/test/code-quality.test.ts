import { startUltracite } from "@grasp-os/compiler";
import { appIdSchema } from "@grasp-os/shared/ids";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { draftLintBuild } from "../src/save-builds.ts";
import { stoppingUltracite } from "./ultracite-stops.ts";

// App code held to Ultracite, in the isolate of its own, by oxlint and
// oxfmt compiled to WebAssembly: what a write saves (`tidy`: fixed and
// formatted) and what it reports (`lint`).

const ultracite = () => startUltracite(env.LOADER, env.ASSETS);

/** An array nested `depth` deep. */
const deep = (depth: number): string =>
  `export const deep = ${"[".repeat(depth)}${"]".repeat(depth)};\n`;

/** Each of `linted`'s findings: its file, line, column and rule. */
const findings = (
  linted: Record<string, { line?: number; column?: number; rule: string }[]>
) =>
  Object.entries(linted).flatMap(([file, found]) =>
    found.map(({ line, column, rule }) => ({ file, line, column, rule }))
  );

describe("tidying App code", { timeout: 60_000 }, () => {
  it("formats TypeScript as Ultracite's oxfmt config does, and fixes what fixes itself", async () => {
    const tidied = await ultracite().tidy({
      "components/total.ts":
        "var rate = 2\nexport const total = (n: number) => { return n*rate }\n",
    });

    expect(tidied).toStrictEqual({
      // `var` that never changes is a `const` (no-var, prefer-const), a
      // body that only returns is the arrow's expression (arrow-body-style),
      // and the code is formatted: semicolons, spacing.
      "components/total.ts":
        "const rate = 2;\nexport const total = (n: number) => n * rate;\n",
    });
  });

  it("never makes a fix that could change what the code does", async () => {
    // A rejection's handler as `then`'s second argument isn't `catch`
    // before `then` (promise/prefer-catch): there, it would handle what
    // the first throws too. `isNaN("abc")` is true and `Number.isNaN`'s
    // false (unicorn/prefer-number-properties). A loose `==` isn't `===`
    // (eqeqeq). oxlint fixes none of them without `--fix-dangerously`.
    const source = [
      "export const settled = async (promise: Promise<number>) =>",
      "  await promise.then(",
      "    (value) => ({ value }),",
      "    (error: unknown) => ({ error })",
      "  );",
      "export const invalid = (text: string) => isNaN(text as never) || !isFinite(text as never);",
      "export const same = (a: unknown, b: unknown) => a == b;",
      "",
    ].join("\n");

    const tidied = await ultracite().tidy({ "components/settle.ts": source });

    expect(tidied["components/settle.ts"]).toMatch(
      /promise\.then\(\s*\(value\) => \(\{ value \}\),\s*\(error: unknown\) => \(\{ error \}\)\s*\)/u
    );
    expect(tidied["components/settle.ts"]).toContain(
      "isNaN(text as never) || !isFinite(text as never)"
    );
    expect(tidied["components/settle.ts"]).toContain("a == b");
  });

  it("makes no fix of a rule an inline config comment turns on, as the agent might write it", async () => {
    // oxlint doesn't read ESLint's inline config comments; were it to,
    // each turns on a rule whose fix it doesn't count as safe: `catch`
    // before `then` would handle what the first handler throws too;
    // `Number.isNaN` answers otherwise for a string.
    const source = [
      '/* eslint "promise/prefer-catch": "error", "unicorn/prefer-number-properties": "error" */',
      "export const settled = async (promise: Promise<number>) =>",
      "  await promise.then(",
      "    (value) => ({ value }),",
      "    (error: unknown) => ({ error })",
      "  );",
      "export const invalid = (text: string) => isNaN(text as never);",
      "",
    ].join("\n");

    const tidied = await ultracite().tidy({ "components/inline.ts": source });

    expect(tidied).toStrictEqual({ "components/inline.ts": source });
  });

  it("leaves what an oxlint disable comment turns off as it is, and keeps the comment as written", async () => {
    const source = [
      "// oxlint-disable-next-line no-var -- kept as written",
      "var kept = 1;",
      "/* oxlint-disable arrow-body-style */",
      "export const one = () => { return kept };",
      "/* oxlint-enable arrow-body-style */",
      "export const two = () => { return kept };",
      "/* oxlint-disable-line no-empty-function */ export const three = () => { return kept };",
      "",
    ].join("\n");

    const tidied = await ultracite().tidy({ "components/kept.ts": source });

    expect(tidied).toStrictEqual({
      "components/kept.ts": [
        "// oxlint-disable-next-line no-var -- kept as written",
        "var kept = 1;",
        "/* oxlint-disable arrow-body-style */",
        "export const one = () => {",
        "  return kept;",
        "};",
        "/* oxlint-enable arrow-body-style */",
        "export const two = () => kept;",
        "/* oxlint-disable-line no-empty-function */ export const three = () => kept;",
        "",
      ].join("\n"),
    });
  });

  it("leaves code that doesn't parse, and files that aren't TypeScript, as they are", async () => {
    const files = {
      "screens/broken.tsx": "export const Broken = () => <div>\n",
      "app.json": '{"name":"Tickets"}',
      "server.d.ts": "export type  Id=string",
    };

    await expect(ultracite().tidy(files)).resolves.toStrictEqual(files);
  });
});

describe("linting App code", { timeout: 60_000 }, () => {
  it("reports every Ultracite rule at its own level, by oxlint's names", async () => {
    const linted = await ultracite().lint({
      "components/flags.ts":
        "export const flags = (list: number[]) => list.filter((n) => n > 0).length > 0;\n",
      "components/sum.ts":
        "export const sum = (a: number, b: number) => a == b;\nexport const noop = () => {};\n",
    });

    expect(
      Object.values(linted)
        .flat()
        .map(({ file, rule, severity }) => ({ file, rule, severity }))
    ).toStrictEqual(
      expect.arrayContaining([
        // ESLint's own, by its own name.
        { file: "components/sum.ts", rule: "eqeqeq", severity: "error" },
        // A rule oxlint has under ESLint's name, as oxlint names it.
        {
          file: "components/sum.ts",
          rule: "no-empty-function",
          severity: "error",
        },
      ])
    );
  });

  it("reads oxlint's disable comments as oxlint does: every rule it knows, by any of its names", async () => {
    const source = [
      // A rule App code isn't held to, as an export's oxlint needs it.
      "// oxlint-disable-next-line oxc/no-barrel-file",
      "export const a = 1;",
      // oxlint's `eslint/` name of ESLint's own rule.
      "// oxlint-disable-next-line eslint/eqeqeq",
      "export const same = (x: number, y: number) => x == y;",
      // oxlint's bare name of a rule.
      "// oxlint-disable-next-line no-empty-function",
      "export const noop = () => {};",
      // A rule oxlint has under a plugin's name.
      "// oxlint-disable-next-line typescript/ban-types",
      "export type Loose = object;",
      // A range, in a line comment.
      "// oxlint-disable eqeqeq",
      "export const loosely = (x: number, y: number) => x == y;",
      "// oxlint-enable eqeqeq",
      // A disable comment's text in a string is a string.
      'export const text = "// oxlint-disable-next-line eqeqeq";',
      "export const loose = (x: number, y: number) => x == y;",
      // Before code on its line: what follows it is found where it is.
      "/* oxlint-disable-line no-empty-function */ export const looser = (x: number, y: number) => x == y;",
      "",
    ].join("\n");

    const linted = await ultracite().lint({ "components/quiet.ts": source });

    expect(findings(linted)).toStrictEqual([
      { file: "components/quiet.ts", line: 13, column: 50, rule: "eqeqeq" },
      { file: "components/quiet.ts", line: 14, column: 95, rule: "eqeqeq" },
    ]);
  });

  it("passes over a disable comment for a rule it doesn't know, as oxlint does", async () => {
    // A rule of a JS plugin an export's oxlint may run, and a typo.
    const source = [
      "// oxlint-disable-next-line react-doctor/no-danger",
      "export const a = 1;",
      "// eslint-disable-next-line github/array-foreach, promise-function-asyncc",
      "export const b = 2;",
      "",
    ].join("\n");

    const linted = await ultracite().lint({ "components/plain.ts": source });

    expect(linted).toStrictEqual({ "components/plain.ts": [] });
  });

  it("runs the rules only oxlint has: oxc's own, and vitest's on a test", async () => {
    const linted = await ultracite().lint({
      "components/merge.ts":
        "export const merge = (items: Record<string, number>[]) =>\n  items.reduce((all, item) => ({ ...all, ...item }), {});\n",
      "tests/count.test.ts":
        'import { describe, expect, it } from "vitest";\n\ndescribe("count", () => {\n  it("counts", () => {\n    expect([1].length).toBe(1);\n  });\n});\n',
    });

    expect(
      findings(linted).map(({ file, rule }) => `${file} ${rule}`)
    ).toStrictEqual(
      expect.arrayContaining([
        "components/merge.ts oxc/no-accumulating-spread",
        "tests/count.test.ts vitest/prefer-to-have-length",
      ])
    );
  });

  it("says nothing of code that doesn't parse: the build says why", async () => {
    await expect(
      ultracite().lint({
        "screens/broken.tsx": "export const Broken = () => <div>\n",
      })
    ).resolves.toStrictEqual({ "screens/broken.tsx": [] });
  });

  it("fails only a file nested too deep for oxc, and lints and tidies the files after it, any App's", async () => {
    // Nested deeper than oxc's recursion has stack for: oxc.wasm traps on
    // it, in the isolate every App's lint shares.
    const tidied = await ultracite().tidy({
      "components/deep.ts": deep(5000),
      "components/after.ts": "export const after = 1\n",
    });
    const linted = await ultracite().lint({
      "components/deep.ts": deep(1000),
      "components/after.ts": "export const after = (a: number) => a == 1;\n",
    });

    // Another App's write and check, in the same isolate.
    expect({
      tidied,
      linted: findings(linted).map(({ file, rule }) => `${file} ${rule}`),
      other: await ultracite().lint({ "b/clean.ts": "export const a = 1;\n" }),
      tidiedOther: await ultracite().tidy({
        "b/clean.ts": "export const a = 1\n",
      }),
    }).toStrictEqual({
      // Saved as written.
      tidied: {
        "components/deep.ts": null,
        "components/after.ts": "export const after = 1;\n",
      },
      linted: ["components/deep.ts lint", "components/after.ts eqeqeq"],
      other: { "b/clean.ts": [] },
      tidiedOther: { "b/clean.ts": "export const a = 1;\n" },
    });
  });

  it("keeps as written a file oxfmt would make larger than an App's file may be", async () => {
    // Formatted, each array nested 300 deep is a line a level, indented:
    // 180,000 characters, from 600 written.
    const grows = Array.from(
      { length: 3 },
      (_, at) =>
        `export const grows${at} = ${"[".repeat(300)}${"]".repeat(300)};`
    ).join("\n");

    await expect(
      ultracite().tidy({ "components/grows.ts": grows })
    ).resolves.toStrictEqual({ "components/grows.ts": null });
  });
});

/** `count` files of an App, each with one finding (`eqeqeq`) and its own text. */
const manyFiles = (count: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: count }, (_, at) => [
      `components/file-${at}.ts`,
      `export const same${at} = (a: number, b: number) => a == b;\n// ${crypto.randomUUID()}\n`,
    ])
  );

/** Each of `diagnostics`' file and rule, sorted. */
const fileRules = (
  diagnostics: readonly { file?: string | null; rule?: string }[]
): string[] =>
  diagnostics.map(({ file, rule }) => `${file ?? ""} ${rule ?? ""}`).toSorted();

/** How many files of `diagnostics` have a finding. */
const filesFound = (diagnostics: readonly { file?: string | null }[]): number =>
  new Set(diagnostics.map(({ file }) => file)).size;

describe("a draft's lint", { timeout: 120_000 }, () => {
  it("lints a large App in batches, keeping each batch's results as it answers", async () => {
    const app = appIdSchema.parse(crypto.randomUUID());
    // As many files as an App may have (`authoringFiles`), more than one
    // call takes (`ultraciteBatch`: 100).
    const files = manyFiles(platformLimits.authoringFiles);
    const first = await draftLintBuild(env, { app, version: 0, files });

    // Every batch's results were kept: with the lint unable to start, a
    // second lint finds them all.
    const { LOADER: loader } = env;
    env.LOADER = {
      get: (name, code) => {
        if (name?.startsWith("ultracite:") === true) {
          throw new Error("The lint can't start");
        }
        return loader.get(name, code);
      },
      load: (code) => loader.load(code),
    };
    try {
      const kept = await draftLintBuild(env, { app, version: 0, files });
      expect({
        first: [first.status, filesFound(first.diagnostics)],
        kept: [kept.status, filesFound(kept.diagnostics)],
      }).toStrictEqual({
        first: ["failed", platformLimits.authoringFiles],
        kept: ["failed", platformLimits.authoringFiles],
      });
    } finally {
      env.LOADER = loader;
    }
  });

  it("splits a call stopped at its CPU time until the file that stops alone, and fails that file alone until a lint of it gets through", async () => {
    const app = appIdSchema.parse(crypto.randomUUID());
    const files = manyFiles(6);
    const [marker = ""] = Object.keys(files);
    const { LOADER: loader } = env;
    env.LOADER = stoppingUltracite(loader, {
      marker,
      limit: "CPU time",
      fresh: true,
    });
    let stopped: Awaited<ReturnType<typeof draftLintBuild>>;
    try {
      stopped = await draftLintBuild(env, { app, version: 0, files });
    } finally {
      env.LOADER = loader;
    }
    // Never kept: the next lint lints it.
    const later = await draftLintBuild(env, { app, version: 0, files });

    const others = Object.keys(files)
      .filter((file) => file !== marker)
      .map((file) => `${file} eqeqeq`);
    expect({
      stopped: fileRules(stopped.diagnostics),
      unlinted: stopped.diagnostics.some(
        ({ file, message }) =>
          file === marker && message.includes("on this file alone")
      ),
      later: fileRules(later.diagnostics),
    }).toStrictEqual({
      stopped: [`${marker} lint`, ...others].toSorted(),
      unlinted: true,
      later: [`${marker} eqeqeq`, ...others].toSorted(),
    });
  });

  it("tries a memory stop in the isolate every App shares again in a fresh one, and blames a file only for its own", async () => {
    const { LOADER: loader } = env;
    /** The rule each of four files (the first stopping) is found breaking. */
    const lintedWith = async (fresh: boolean) => {
      // Text of their own, so no lint before has kept their results.
      const files = manyFiles(4);
      const [marker = ""] = Object.keys(files);
      env.LOADER = stoppingUltracite(loader, {
        marker,
        limit: "memory",
        fresh,
      });
      try {
        const { diagnostics } = await draftLintBuild(env, {
          app: appIdSchema.parse(crypto.randomUUID()),
          version: 0,
          files,
        });
        return Object.keys(files).map(
          (file) => diagnostics.find((found) => found.file === file)?.rule
        );
      } finally {
        env.LOADER = loader;
      }
    };

    expect({
      // Another call's memory, as far as this one knows: the fresh
      // isolate lints every file.
      shared: await lintedWith(false),
      // Its own: the fresh isolate stops on it too.
      own: await lintedWith(true),
    }).toStrictEqual({
      shared: ["eqeqeq", "eqeqeq", "eqeqeq", "eqeqeq"],
      own: ["lint", "eqeqeq", "eqeqeq", "eqeqeq"],
    });
  });

  it("lints only the files that changed, keeping each file's result by its content", async () => {
    const app = appIdSchema.parse(crypto.randomUUID());
    const files = {
      "components/same.ts": `export const same = (a: number, b: number) => a == b;\n// ${crypto.randomUUID()}\n`,
      "components/sum.ts": `export const sum = (a: number, b: number) => a + b;\n// ${crypto.randomUUID()}\n`,
    };
    const first = await draftLintBuild(env, { app, version: 0, files });

    // The lint can't start now: what was linted is kept, a new file isn't.
    const { LOADER: loader } = env;
    env.LOADER = {
      get: (name, code) => {
        if (name?.startsWith("ultracite:") === true) {
          throw new Error("The lint can't start");
        }
        return loader.get(name, code);
      },
      load: (code) => loader.load(code),
    };
    try {
      const kept = await draftLintBuild(env, { app, version: 0, files });
      const changed = await draftLintBuild(env, {
        app,
        version: 0,
        files: { ...files, "components/new.ts": "export const one = 1;\n" },
      });
      expect({
        first: [first.status, first.diagnostics.map(({ rule }) => rule)],
        kept: [kept.status, kept.diagnostics.map(({ rule }) => rule)],
        changed: changed.status,
      }).toStrictEqual({
        first: ["failed", ["eqeqeq"]],
        kept: ["failed", ["eqeqeq"]],
        changed: "error",
      });
    } finally {
      env.LOADER = loader;
    }
  });
});
