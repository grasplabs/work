import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { writeReference } from "./reference.ts";

// The reference fails as a type error would when a doc comment points at
// nothing, so the SDK's docs can't drift from its code unnoticed.

/** TypeDoc reads a whole program: a minute at most. */
const referenceTimeout = 60_000;

const made: string[] = [];

/** The reference of one module with `source`, written to its own folder. */
const referenceOf = async (source: string): Promise<string[]> => {
  const dir = mkdtempSync(path.join(tmpdir(), "grasp-docs-reference-"));
  made.push(dir);
  writeFileSync(path.join(dir, "index.ts"), source);
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, target: "es2024", module: "preserve" },
      include: ["index.ts"],
    })
  );
  const out = path.join(dir, "reference");
  await writeReference({
    entryPoints: [path.join(dir, "index.ts")],
    tsconfig: path.join(dir, "tsconfig.json"),
    out,
    readme: "none",
    logLevel: "None",
  });
  return readdirSync(out);
};

describe("the API reference", () => {
  afterEach(() => {
    for (const dir of made.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it(
    "is written when every link names something",
    async () => {
      await expect(
        referenceOf(
          "/** A task. */\nexport interface Task { title: string }\n/** Adds a {@link Task}. */\nexport const add = (task: Task): Task => task;\n"
        )
      ).resolves.not.toHaveLength(0);
    },
    referenceTimeout
  );

  it(
    "fails, writing nothing, on a {@link} to nothing",
    async () => {
      await expect(
        referenceOf(
          "/** Adds a {@link Missing}. */\nexport const add = (title: string): string => title;\n"
        )
      ).rejects.toThrow("validation failed");
    },
    referenceTimeout
  );
});
