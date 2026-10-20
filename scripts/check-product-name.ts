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

/** A field of a PO entry, its name and its first quoted part. */
const poField =
  /^(?<name>msgctxt|msgid|msgid_plural|msgstr(?:\[\d+\])?)\s+"(?<part>.*)"\s*$/u;

/** A quoted part that continues the field above it. */
const poPart = /^"(?<part>.*)"\s*$/u;

/** C's escapes, which PO strings use: named, octal (`\040`) and hex (`\x20`). */
const poEscape =
  /\\(?:(?<octal>[0-7]{1,3})|x(?<hex>[0-9a-fA-F]{1,2})|(?<named>.))/gu;

const namedEscapes: Readonly<Record<string, string>> = {
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/** One escape of a PO string as it reads. */
const unescaped = (
  _escape: string,
  octal: string | undefined,
  hex: string | undefined,
  named: string | undefined
): string => {
  if (octal !== undefined) {
    return String.fromCodePoint(Number.parseInt(octal, 8));
  }
  if (hex !== undefined) {
    return String.fromCodePoint(Number.parseInt(hex, 16));
  }
  return namedEscapes[named ?? ""] ?? named ?? "";
};

/** A quoted PO part as it reads, its escapes decoded. */
const decoded = (part: string): string => part.replaceAll(poEscape, unescaped);

/**
 * The messages of a PO catalog as people read them, each with the line
 * it starts on: its parts joined with nothing between them and their
 * escapes decoded. Comments, obsolete entries (`#~`) and contexts
 * (`msgctxt`, which tells messages apart and is never shown) are no one's.
 */
const poMessages = (text: string): { value: string; line: number }[] => {
  const messages: { value: string; line: number }[] = [];
  // The field a quoted part continues, while there is one.
  let open: { value: string; line: number } | undefined;
  for (const [index, line] of text.split("\n").entries()) {
    const field = poField.exec(line)?.groups;
    const part = poPart.exec(line)?.groups?.part;
    if (field?.part !== undefined) {
      open = { value: decoded(field.part), line: index + 1 };
      if (field.name !== "msgctxt") {
        messages.push(open);
      }
    } else if (part !== undefined && open !== undefined) {
      open.value += decoded(part);
    } else {
      // Anything else ends the field: a comment, a blank line.
      open = undefined;
    }
  }
  return messages;
};

/** What people read in a file, each piece with the line it starts on. */
const readPieces = (
  path: string,
  text: string
): { value: string; lineOf: (index: number) => number }[] =>
  path.endsWith(".po")
    ? poMessages(text).map(({ value, line }) => ({ value, lineOf: () => line }))
    : [{ value: text, lineOf: (index) => lineIn(text, index) }];

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
  files.flatMap(({ path, text }) =>
    readPieces(path, text).flatMap(({ value, lineOf }) =>
      findOldProductNames(value).map(
        ({ found, index }) =>
          `${path}:${lineOf(index)}: ${JSON.stringify(found)}`
      )
    )
  );

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
