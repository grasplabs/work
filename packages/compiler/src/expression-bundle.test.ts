/**
 * The expression check as it runs outside Vitest, whose module loader
 * smooths over CommonJS interop: under plain Node ESM, from its source,
 * and bundled by esbuild into one ES module, as a Worker's code is. A
 * default import of a CommonJS package (`@babel/generator`) is the whole
 * `module.exports` there, not its function.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { build } from "esbuild-wasm";
import { describe, expect, it } from "vite-plus/test";

const entry = createRequire(import.meta.url).resolve(
  "@grasp-os/sdk/expression-check"
);

/** What a module importing `checkExpression` from `specifier` prints. */
const script = (specifier: string): string =>
  `const { checkExpression } = await import(${JSON.stringify(specifier)});
const checked = checkExpression("input.lines.map((line) => line.total)");
console.log(JSON.stringify(checked.ok && checked.code));`;

const expected = JSON.stringify(
  '($json(input), ($call($read(input, "lines"), "map", [line => ($read(line, "total"))])))'
);

/** Runs a module under plain Node, outside Vitest, and gives what it printed. */
const node = (source: string): string =>
  execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf-8",
  }).trim();

describe("the expression check outside Vitest", () => {
  it("generates code under plain Node ESM, from its source", () => {
    expect(node(script(entry))).toBe(expected);
  });

  it("generates code bundled into one ES module", async () => {
    const bundled = await build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "node",
      write: false,
      logLevel: "silent",
    });
    const directory = mkdtempSync(path.join(tmpdir(), "expression-bundle-"));
    try {
      const file = path.join(directory, "expression-check.mjs");
      writeFileSync(file, bundled.outputFiles[0]?.text ?? "");
      expect(node(script(file))).toBe(expected);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
