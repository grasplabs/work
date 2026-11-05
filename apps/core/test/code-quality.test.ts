import { startUltracite } from "@grasp-os/compiler";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { draftLintBuild } from "../src/save-builds.ts";

// App code held to Ultracite, in the isolate of its own: what a write
// saves (`tidy`: fixed and formatted) and what it reports (`lint`).

const ultracite = () => startUltracite(env.LOADER, env.ASSETS);

/** Each of `linted`'s findings: its file, line and rule. */
const findings = (linted: Record<string, { line?: number; rule: string }[]>) =>
  Object.entries(linted).flatMap(([file, found]) =>
    found.map(({ line, rule }) => ({ file, line, rule }))
  );

describe("tidying App code", { timeout: 60_000 }, () => {
  it("formats TypeScript as Ultracite's Prettier config does, and fixes what fixes itself", async () => {
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
    // Each comment turns on a rule whose ESLint fix oxlint doesn't count
    // as safe: `catch` before `then` would handle what the first handler
    // throws too; `Number.isNaN` answers otherwise for a string.
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
        // typescript-eslint's, standing in for oxlint's own: as oxlint
        // names it.
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
      // A rule oxc has and nothing here runs, as an export's oxlint needs it.
      "// oxlint-disable-next-line oxc/no-barrel-file",
      "export const a = 1;",
      // oxlint's `eslint/` name of ESLint's own rule.
      "// oxlint-disable-next-line eslint/eqeqeq",
      "export const same = (x: number, y: number) => x == y;",
      // oxlint's bare name of a rule typescript-eslint stands in for.
      "// oxlint-disable-next-line no-empty-function",
      "export const noop = () => {};",
      // A rule the ESLint plugins no longer have.
      "// oxlint-disable-next-line typescript/ban-types",
      "export type Loose = object;",
      // A range, in a line comment, which oxlint reads and ESLint doesn't.
      "// oxlint-disable eqeqeq",
      "export const loosely = (x: number, y: number) => x == y;",
      "// oxlint-enable eqeqeq",
      // A disable comment's text in a string is a string.
      'export const text = "// oxlint-disable-next-line eqeqeq";',
      "export const loose = (x: number, y: number) => x == y;",
      "",
    ].join("\n");

    const linted = await ultracite().lint({ "components/quiet.ts": source });

    expect(findings(linted)).toStrictEqual([
      { file: "components/quiet.ts", line: 13, rule: "eqeqeq" },
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

  it("reports sonarjs's rules as warnings, which a write never fixes and a draft passes with", async () => {
    const app = appIdSchema.parse(crypto.randomUUID());
    const source = `export const positive = (n: number): boolean => {\n  if (n > 0) {\n    return true;\n  }\n  return false;\n};\n// ${crypto.randomUUID()}\n`;

    const tidied = await ultracite().tidy({ "components/positive.ts": source });
    const linted = await draftLintBuild(env, {
      app,
      version: 0,
      files: { "components/positive.ts": source },
    });

    expect({
      tidied: tidied["components/positive.ts"] === source,
      status: linted.status,
      found: linted.diagnostics.map(({ rule, severity }) => ({
        rule,
        severity,
      })),
    }).toStrictEqual({
      tidied: true,
      status: "ok",
      found: [
        {
          rule: "sonarjs/prefer-single-boolean-return",
          severity: "warning",
        },
      ],
    });
  });

  it("says nothing of code that doesn't parse: the build says why", async () => {
    await expect(
      ultracite().lint({
        "screens/broken.tsx": "export const Broken = () => <div>\n",
      })
    ).resolves.toStrictEqual({ "screens/broken.tsx": [] });
  });
});

describe("a draft's lint", { timeout: 60_000 }, () => {
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
