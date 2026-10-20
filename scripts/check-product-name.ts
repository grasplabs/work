/**
 * What clients and buyers read outside code names the product Grasp Work,
 * never Grasp OS (GRA-143): the frontend's translation catalogs, HTML
 * pages and manifests, and the skills and templates the platform sends or
 * shows. Strings in code are held by the lint (`grasp/no-old-product-name`).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { findOldProductName } from "./lint/old-product-name.ts";

/** The files people read that aren't code: by extension, in the apps and packages. */
const readFiles =
  /^(?:apps|packages)\/.+\.(?:po|html|md|txt|webmanifest|xml|svg)$/u;

/** Not what clients read: tests and their fixtures. */
const notRead = /(?:^|\/)(?:test|tests|e2e)\/|\.test\.[cm]?[jt]sx?$/u;

/** Which of `paths` people read: those `readFiles` names and `notRead` doesn't. */
export const readPaths = (paths: readonly string[]): string[] =>
  paths.filter((path) => readFiles.test(path) && !notRead.test(path));

/** Each of `files` that names the old product, with what it found and on which line. */
export const oldProductNames = (
  files: readonly { path: string; text: string }[]
): string[] =>
  files.flatMap(({ path, text }) =>
    text.split("\n").flatMap((line, index) => {
      const found = findOldProductName(line);
      return found === undefined ? [] : [`${path}:${index + 1}: "${found}"`];
    })
  );

const main = (): void => {
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf-8" }
  ).split("\n");
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
