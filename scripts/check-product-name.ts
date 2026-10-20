/**
 * What clients and buyers read outside code names the product Grasp Work,
 * never Grasp OS (GRA-143): the frontend's translation catalogs, HTML
 * pages and manifests, the skills and templates the platform sends or
 * shows, and the built-in Apps' files, which the root lint leaves to the
 * screen build (vite.config.ts). Strings in other code are held by the
 * lint (`grasp/no-old-product-name`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { findOldProductNames } from "./lint/old-product-name.ts";

/**
 * The files people read that the lint doesn't: by extension in the apps
 * and packages, and every file of a built-in App.
 */
const readFiles =
  /^(?:(?:apps|packages)\/.+\.(?:po|html|md|txt|webmanifest|xml|svg)|apps\/core\/blueprints\/[^/]+\/files\/.+)$/u;

/** The line of `text` its character `index` is on. */
const lineIn = (text: string, index: number): number =>
  text.slice(0, index).split("\n").length;

/** Where a PO message wraps onto its next quoted line. */
const poWrap = /"[ \t]*\n[ \t]*"/gu;

/**
 * A file's text as people read it, and the line of the file each of its
 * characters is on: a PO catalog's messages joined up where they wrap
 * over quoted lines, which adds nothing between the parts.
 */
const readAs = (
  path: string,
  written: string
): { text: string; lineOf: (index: number) => number } => {
  if (!path.endsWith(".po")) {
    return { text: written, lineOf: (index) => lineIn(written, index) };
  }
  // Each joined character's index in the file as written.
  const positions: number[] = [];
  let text = "";
  let from = 0;
  for (const wrap of written.matchAll(poWrap)) {
    for (let at = from; at < wrap.index; at += 1) {
      positions.push(at);
    }
    text += written.slice(from, wrap.index);
    from = wrap.index + wrap[0].length;
  }
  for (let at = from; at < written.length; at += 1) {
    positions.push(at);
  }
  text += written.slice(from);
  return {
    text,
    lineOf: (index) => lineIn(written, positions[index] ?? written.length),
  };
};

/** Not what clients read: tests and their fixtures. */
const notRead = /(?:^|\/)(?:test|tests|e2e)\/|\.test\.[cm]?[jt]sx?$/u;

/** Which of `paths` people read: those `readFiles` names and `notRead` doesn't. */
export const readPaths = (paths: readonly string[]): string[] =>
  paths.filter((path) => readFiles.test(path) && !notRead.test(path));

/**
 * Each place in `files` that names the old product, with what it found
 * and on which line it starts: a name wrapped across lines counts too.
 */
export const oldProductNames = (
  files: readonly { path: string; text: string }[]
): string[] =>
  files.flatMap(({ path, text: written }) => {
    const { text, lineOf } = readAs(path, written);
    return findOldProductNames(text).map(
      ({ found, index }) => `${path}:${lineOf(index)}: ${JSON.stringify(found)}`
    );
  });

const main = (): void => {
  const paths = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf-8" }
  )
    .split("\0")
    // A tracked file deleted and not yet staged is listed, but not there.
    .filter((path) => path !== "" && existsSync(path));
  const found = oldProductNames(
    readPaths(paths).map((path) => ({
      path,
      text: readFileSync(path, "utf-8"),
    }))
  );
  if (found.length > 0) {
    console.error(
      `The product is Grasp Work; these name it Grasp OS:\n${found.map((line) => `  ${line}`).join("\n")}`
    );
    process.exit(1);
  }
};

if (import.meta.main) {
  main();
}
