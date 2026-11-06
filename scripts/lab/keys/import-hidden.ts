/**
 * `vp run lab import-hidden <prototype checkout>`: the hidden test set
 * (keys 03 and 06) brought over from the prototype, where the lab began
 * (grasplabs/prototype, packages/grasp/lab/keys/hidden/), into the folder
 * `LAB_HIDDEN` names, as `keys/<id>.json`, the way this lab reads them
 * (index.ts). Each key is held to the answer key's schema and its checks
 * before it is written; what is said about it is how many facts and
 * people it has, or which fields don't fit, never what any of them hold:
 * nobody reads a hidden key, people and models alike.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { hiddenFolder, hiddenKeyIds, HiddenSetError } from "./index.ts";
import { answerKeySchema, problemsIn } from "./types.ts";

/** Where the prototype keeps the hidden keys, in its checkout. */
const prototypeKeys = "packages/grasp/lab/keys/hidden";

/** A prototype key's module: it exports the key as `key`. */
const keyModuleSchema = z.object({ key: z.unknown() });

/** Writes the hidden keys from a prototype checkout into `LAB_HIDDEN`, and says where; never what they hold. */
export const importHidden = async (
  prototype: string,
  log: (line: string) => void
): Promise<void> => {
  const folder = hiddenFolder();
  const source = path.join(path.resolve(prototype), prototypeKeys);
  let names: string[];
  try {
    names = readdirSync(source);
  } catch {
    throw new HiddenSetError(
      `There are no hidden keys at ${source}: name a checkout of grasplabs/prototype.`
    );
  }
  mkdirSync(path.join(folder, "keys"), { recursive: true });
  for (const id of hiddenKeyIds) {
    const name = names.find(
      (each) => each.startsWith(`${id}-`) && each.endsWith(".ts")
    );
    if (name === undefined) {
      throw new HiddenSetError(`The prototype has no hidden key ${id}.`);
    }
    // oxlint-disable-next-line no-await-in-loop -- one key at a time
    const loaded: unknown = await import(
      pathToFileURL(path.join(source, name)).href
    );
    const parsed = answerKeySchema.safeParse(keyModuleSchema.parse(loaded).key);
    if (!parsed.success) {
      // Which fields, never what they hold.
      throw new HiddenSetError(
        `Hidden key ${id} doesn't fit: ${[...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].join(", ")}.`
      );
    }
    const problems = problemsIn(parsed.data);
    if (problems.length > 0) {
      throw new HiddenSetError(
        `Hidden key ${id} has ${problems.length} problems; fix it in the prototype first.`
      );
    }
    const file = path.join(folder, "keys", `${id}.json`);
    writeFileSync(file, `${JSON.stringify(parsed.data, null, 2)}\n`);
    log(
      `Hidden key ${id}: ${parsed.data.facts.length} facts, ${parsed.data.employees.length} people, written to ${file}.`
    );
  }
};
