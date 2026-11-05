/**
 * What ties oxc.wasm to this repo: the hash of its glue (every file
 * build.sh builds it from: Cargo.toml, build.sh and src/), which pin.json
 * pins beside oxc's commit, and the release both name. A change to the
 * glue or the commit is a release of another name, so a pin can never
 * name a build of other glue; and while pin.json's `glue` isn't this
 * tree's, nothing reads oxc.wasm (wasm.ts), so CI fails.
 *
 * No dependencies: the Build oxc WASM workflow runs it before anything is
 * installed. `node packages/compiler/oxc-wasm/glue.ts` prints this tree's
 * glue hash; with `--release`, the release pin.json names, once its glue
 * is this tree's.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const here = import.meta.dirname;

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The files build.sh builds oxc.wasm from, by path in this folder, sorted. */
const glueFiles = (): string[] =>
  [
    "Cargo.toml",
    "build.sh",
    ...readdirSync(path.join(here, "src"), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path
          .relative(here, path.join(entry.parentPath, entry.name))
          .replaceAll(path.sep, "/")
      ),
  ].toSorted();

/** The SHA-256 of the glue: each file's path and its own SHA-256, a line each. */
export const glueHash = (): string =>
  sha256(
    glueFiles()
      .map(
        (file) => `${sha256(readFileSync(path.join(here, file)))}  ${file}\n`
      )
      .join("")
  );

/** What names a build of oxc.wasm: pin.json's. */
export interface OxcWasmBuild {
  /** The oxlint release (oxc's tag `oxlint_v<oxlint>`, which releases oxfmt too). */
  oxlint: string;
  /** The commit of oxc it is built from: the tag's, as tags can move. */
  oxc: string;
  /** The glue it is built with (`glueHash`). */
  glue: string;
}

/** The release of this repo that holds the build of `build`. */
export const oxcWasmRelease = ({ oxlint, oxc, glue }: OxcWasmBuild): string =>
  `oxc-wasm-v${oxlint}-${oxc.slice(0, 12)}-${glue.slice(0, 12)}`;

/** Throws unless `pinned` is this tree's glue. */
export const assertGlue = (pinned: string): void => {
  const found = glueHash();
  if (found !== pinned) {
    throw new Error(
      `packages/compiler/oxc-wasm changed since the oxc.wasm pin.json pins was built: its glue is ${found}, not the ${pinned} pin.json pins. Set pin.json's glue to it, build the new release with the Build oxc WASM workflow, and pin its SHA-256.`
    );
  }
};

if (import.meta.main) {
  const { values } = parseArgs({ options: { release: { type: "boolean" } } });
  if (values.release === true) {
    // Read without Zod, as nothing is installed; wasm.ts checks its shape.
    const pin: unknown = JSON.parse(
      readFileSync(path.join(here, "pin.json"), "utf-8")
    );
    const field = (key: keyof OxcWasmBuild): string => {
      const value: unknown =
        typeof pin === "object" && pin !== null
          ? Reflect.get(pin, key)
          : undefined;
      if (typeof value !== "string") {
        throw new TypeError(`pin.json has no ${key}`);
      }
      return value;
    };
    assertGlue(field("glue"));
    console.info(
      oxcWasmRelease({
        oxlint: field("oxlint"),
        oxc: field("oxc"),
        glue: field("glue"),
      })
    );
  } else {
    console.info(glueHash());
  }
}
