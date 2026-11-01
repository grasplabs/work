/**
 * Where the lab keeps what it makes. A practice company and what was said
 * in it stay out of git (`scripts/lab/out/`, ignored); results are JSON,
 * one file a run (`scripts/lab/results/`), and the summary of a round goes
 * in a Linear document, never in Markdown here. Everything made from a
 * hidden key is kept in the hidden set's own folder, outside the
 * repository (keys/index.ts): its practice companies, its transcripts and
 * its results alike.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { z } from "zod";

import { hiddenFolder, isHidden } from "./keys/index.ts";

const here = import.meta.dirname;

/** The lab's own folders, for what is made from an open key. */
const openFolders = {
  out: path.join(here, "out"),
  results: path.join(here, "results"),
  fixtures: path.join(here, "fixtures"),
} as const;

export type Place = keyof typeof openFolders;

/** The open set's cases, which may be read, or the hidden set's, of which only scores are shown. */
export type CaseSet = "open" | "hidden";

/** Where something of `set` is kept: the hidden set's own folder, outside the repository, for the hidden set. */
export const setFolder = (place: Place, set: CaseSet): string =>
  set === "hidden" ? path.join(hiddenFolder(), place) : openFolders[place];

/** Where something made from `key` is kept: the hidden set's own folder for a hidden key. */
export const folderOf = (place: Place, key: string): string =>
  setFolder(place, isHidden(key) ? "hidden" : "open");

/** Keeps `value` as JSON at `file`, and says where. */
export const keepJson = (file: string, value: unknown): string => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
};

/** Keeps `text` at `file`, and says where. */
export const keepText = (file: string, text: string): string => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
};

/**
 * What was kept at `file`, held to `schema`; `undefined` when there is
 * nothing, or it doesn't fit. One that doesn't fit is left out, never
 * read another way (nothing kept is carried over from an older shape),
 * but said out loud, naming it: it was kept before what the lab keeps
 * changed, such as a run reached through AI Gateway, and is re-run or
 * deleted rather than quietly missing from every comparison.
 */
export const keptJson = <T>(
  file: string,
  schema: z.ZodType<T>
): T | undefined => {
  if (!existsSync(file)) {
    return undefined;
  }
  let kept: unknown = undefined;
  try {
    kept = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    // Not JSON: left out, and said, as one of an older shape.
  }
  const parsed = schema.safeParse(kept);
  if (!parsed.success) {
    console.warn(
      `Left out ${file}: it doesn't fit what the lab keeps now, so it predates a change to it. Run it again, or delete it.`
    );
    return undefined;
  }
  return parsed.data;
};

/** Every JSON file kept in `folder`, held to `schema`, by name. */
export const allKept = <T>(folder: string, schema: z.ZodType<T>): T[] =>
  existsSync(folder)
    ? readdirSync(folder)
        .filter((name) => name.endsWith(".json"))
        .toSorted()
        .flatMap((name) => keptJson(path.join(folder, name), schema) ?? [])
    : [];

/** The open set's folder for `place`. */
export const openFolder = (place: Place): string => openFolders[place];
