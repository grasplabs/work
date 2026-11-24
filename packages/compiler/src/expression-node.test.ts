/**
 * The expression check under plain Node.js, outside Vitest, as the seed
 * runs it: the SDK's parser loads oxc-parse.wasm from its file there
 * (`#oxc-parse`'s `node` condition), where a Worker imports it as a
 * module of its bundle.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import { describe, expect, it } from "vite-plus/test";

const entry = createRequire(import.meta.url).resolve("@grasp-os/runtime/check");

describe("the expression check under plain Node", () => {
  it("generates code under plain Node ESM, from its source", () => {
    const printed = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { checkExpression } = await import(${JSON.stringify(entry)});
const checked = checkExpression("args.lines.map((line) => line.total)");
console.log(JSON.stringify(checked.ok && checked.code));`,
      ],
      { encoding: "utf-8" }
    ).trim();
    expect(printed).toBe(
      JSON.stringify("(args.lines.map(line => line.total))")
    );
  });
});
