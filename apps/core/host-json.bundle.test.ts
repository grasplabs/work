import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { parseJsonc } from "../../scripts/wrangler-config-rules.ts";
import { hostJsonSource } from "./src/host-json.ts";

// The host's JSON module (src/host-json.ts) as Wrangler bundles core, in
// Node (the root config's "scripts" project): esbuild with `keepNames`,
// which renames a declaration whose name collides with another's, under
// core's own compatibility settings, unminified as core ships and
// minified as it might. The fixture is a Worker that imports the module
// next to a function of the same name as the reader's, bundled by
// Wrangler itself (a dry run). The source it hands an isolate must read
// values with nothing in scope but the language's built-ins.

const here = import.meta.dirname;
const wrangler = path.join(here, "node_modules/wrangler/bin/wrangler.js");

/** Core's own compatibility settings, from its wrangler.jsonc. */
const coreSettings = (): Record<string, unknown> => {
  const config = parseJsonc(
    readFileSync(path.join(here, "wrangler.jsonc"), "utf-8")
  );
  const field = (name: string): unknown =>
    typeof config === "object" && config !== null
      ? Reflect.get(config, name)
      : undefined;
  return {
    compatibility_date: field("compatibility_date"),
    compatibility_flags: field("compatibility_flags"),
  };
};

/** The function `name` that the module at `file` exports. */
const exported = async (
  file: string,
  name: string
): Promise<(...args: unknown[]) => unknown> => {
  const module: unknown = await import(pathToFileURL(file).href);
  const value: unknown =
    typeof module === "object" && module !== null
      ? Reflect.get(module, name)
      : undefined;
  if (typeof value !== "function") {
    throw new TypeError(`${file} exports no function ${name}`);
  }
  return (...args): unknown => {
    const result: unknown = Reflect.apply(value, undefined, args);
    return result;
  };
};

/**
 * What `jsonAnswer` of the module `source` answers for each of the values
 * `cases` (source text) builds, all evaluated in a context of their own:
 * the language's built-ins and nothing else, as in an isolate, and values
 * of that context's own realm, as App code's are of its isolate's.
 */
const isolatedAnswers = (source: string, cases: string): unknown[] => {
  const context: Record<string, unknown> = {};
  runInNewContext(
    `${source.replace("export const jsonAnswer", "const jsonAnswer")}
globalThis.answers = (${cases}).map((value) => jsonAnswer(value));`,
    context
  );
  const { answers } = context;
  // A copy of this realm's: the answers themselves are strings or undefined.
  return Array.isArray(answers)
    ? Array.from(answers, (answer: unknown) => answer)
    : [];
};

describe("the host's JSON module, bundled as Wrangler bundles core", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "host-json-bundle-"));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ["unminified, as core ships", false],
    ["minified", true],
  ])(
    "reads values the way the host does, %s, whatever names the bundler gave",
    async (label, minify) => {
      const fixture = path.join(dir, minify ? "minified" : "plain");
      mkdirSync(fixture, { recursive: true });
      writeFileSync(
        path.join(fixture, "collide.ts"),
        'export function readJsonValue(): string {\n  return "another";\n}\n'
      );
      writeFileSync(
        path.join(fixture, "entry.ts"),
        [
          'import { readJsonValue } from "./collide.ts";',
          `import { hostJsonSource } from ${JSON.stringify(path.join(here, "src/host-json.ts"))};`,
          "export const another = readJsonValue;",
          "export const source = hostJsonSource;",
          'export default { fetch: () => new Response("") };',
          "",
        ].join("\n")
      );
      writeFileSync(
        path.join(fixture, "wrangler.jsonc"),
        JSON.stringify({
          name: "host-json-bundle",
          main: "entry.ts",
          ...coreSettings(),
        })
      );
      execFileSync(
        process.execPath,
        [
          wrangler,
          "deploy",
          "--dry-run",
          "--outdir",
          "out",
          ...(minify ? ["--minify"] : []),
        ],
        {
          cwd: fixture,
          env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
          stdio: "pipe",
        }
      );
      const bundle = path.join(fixture, "out/entry.js");
      const source = String((await exported(bundle, "source"))());
      const answers = isolatedAnswers(
        source,
        `(() => {
          const cycle = {};
          cycle.self = cycle;
          return [
            { title: "Note", tags: ["a"], count: 2, done: null },
            [[1, 2], { deep: [true] }],
            Number.NaN,
            [undefined],
            cycle,
            () => null,
          ];
        })()`
      );
      expect([
        label,
        // Unminified, the collision is resolved by renaming one of the two.
        minify ||
          /function readJsonValue2\(/u.test(readFileSync(bundle, "utf-8")),
        answers,
      ]).toStrictEqual([
        label,
        true,
        [
          '{"title":"Note","tags":["a"],"count":2,"done":null}',
          '[[1,2],{"deep":[true]}]',
          undefined,
          undefined,
          undefined,
          undefined,
        ],
      ]);
    }
  );

  it("refuses a reader whose source calls a bundler helper the isolate lacks", () => {
    // What keepNames makes of a reader with a named function nested in it.
    const wrapped = Object.assign((value: unknown) => value, {
      toString: () =>
        'function read(value) { const inner = __name(() => value, "inner"); return inner(); }',
    });
    expect(() => hostJsonSource(wrapped)).toThrow(/bundler helper/u);
  });
});
