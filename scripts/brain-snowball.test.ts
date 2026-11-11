import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { problemsIn } from "./brain-snowball.ts";

/** The committed stemmers, as `check:snowball` reads them. */
const committed = path.join(
  import.meta.dirname,
  "../packages/brain-next/src/snowball"
);

describe("the vendored Snowball stemmers", () => {
  it("are the pinned release's files, and nothing else", () => {
    expect(problemsIn(committed)).toStrictEqual([]);
  });

  it("name a file of our own put among them, and a hand edit", () => {
    const copy = mkdtempSync(path.join(tmpdir(), "snowball-check-"));
    try {
      cpSync(committed, copy, { recursive: true });
      writeFileSync(path.join(copy, "helpers.js"), "export const x = 1;\n");
      writeFileSync(path.join(copy, "dutch-stemmer.js"), "// edited\n", {
        flag: "a",
      });

      expect(problemsIn(copy)).toStrictEqual([
        "dutch-stemmer.js differs from the release",
        "helpers.js is not one of the release's files",
      ]);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});
