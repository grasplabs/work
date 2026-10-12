import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { hostJsonSource } from "./src/host-json.ts";

// The host's JSON module (src/host-json.ts) as Wrangler bundles core, in
// Node (the root config's "scripts" project): esbuild with `keepNames`,
// which renames a declaration whose name collides with another's. The
// fixture is a Worker that imports the module next to a function of the
// same name as the reader's, bundled by Wrangler itself (a dry run), then
// loaded: the module source it hands an isolate must still read values.

const here = import.meta.dirname;
const wrangler = path.join(here, "node_modules/wrangler/bin/wrangler.js");

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

describe("the host's JSON module, bundled as Wrangler bundles core", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "host-json-bundle-"));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads values the way the host does, whatever name the bundler gave its reader", async () => {
    writeFileSync(
      path.join(dir, "collide.ts"),
      'export function readJsonValue(): string {\n  return "another";\n}\n'
    );
    writeFileSync(
      path.join(dir, "entry.ts"),
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
      path.join(dir, "wrangler.jsonc"),
      JSON.stringify({
        name: "host-json-bundle",
        main: "entry.ts",
        compatibility_date: "2026-09-01",
      })
    );
    execFileSync(
      process.execPath,
      [wrangler, "deploy", "--dry-run", "--outdir", "out"],
      {
        cwd: dir,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
        stdio: "pipe",
      }
    );
    const bundle = path.join(dir, "out/entry.js");
    const source = await exported(bundle, "source");
    const hostModule = path.join(dir, "host-json.mjs");
    writeFileSync(hostModule, String(source()));
    const jsonAnswer = await exported(hostModule, "jsonAnswer");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect([
      // The collision the bundler resolved by renaming one of the two.
      /function readJsonValue2\(/u.test(readFileSync(bundle, "utf-8")),
      jsonAnswer({ title: "Note", tags: ["a"], count: 2, done: null }),
      jsonAnswer([[1, 2], { deep: [true] }]),
      jsonAnswer(Number.NaN),
      jsonAnswer([undefined]),
      jsonAnswer(cycle),
      jsonAnswer(() => null),
    ]).toStrictEqual([
      true,
      '{"title":"Note","tags":["a"],"count":2,"done":null}',
      '[[1,2],{"deep":[true]}]',
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("refuses a reader whose source calls a bundler helper the isolate lacks", () => {
    // What keepNames makes of a reader with a named function nested in it.
    const wrapped = Object.assign((value: unknown) => value, {
      toString: () =>
        'function read(value) { const inner = __name(() => value, "inner"); return inner(); }',
    });
    expect(() => hostJsonSource(wrapped)).toThrow(/bundler helper/u);
  });
});
