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

/** Where something made from `key` is kept: the hidden set's own folder for a hidden key. */
export const folderOf = (place: Place, key: string): string =>
  isHidden(key) ? path.join(hiddenFolder(), place) : openFolders[place];

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

/** What was kept at `file`, held to `schema`; `undefined` when there is nothing, or it doesn't fit. */
export const keptJson = <T>(
  file: string,
  schema: z.ZodType<T>
): T | undefined => {
  if (!existsSync(file)) {
    return undefined;
  }
  const parsed = schema.safeParse(JSON.parse(readFileSync(file, "utf-8")));
  return parsed.success ? parsed.data : undefined;
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
