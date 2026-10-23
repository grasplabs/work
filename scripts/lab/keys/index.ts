/**
 * The answer keys. Four are here to practise and to improve on. Keys 03
 * and 06 are the hidden test set: they are never in this repository, and
 * nobody opens them, people and models alike, so a change that only fits
 * what was looked at shows. A run reads them from a folder outside the
 * repository, named by `LAB_HIDDEN` (`<folder>/keys/03.json`), and keeps
 * everything made from them there too: practice companies, transcripts
 * and results. Only their scores are ever shown.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { key as supplierInvoices } from "./01-supplier-invoices.ts";
import { key as customerTickets } from "./02-customer-tickets.ts";
import { key as mortgageApplication } from "./04-mortgage-application.ts";
import { key as insuranceClaim } from "./05-insurance-claim.ts";
import { answerKeySchema } from "./types.ts";
import type { AnswerKey } from "./types.ts";

/** The keys to practise and to improve on, by id. */
export const openKeys: Readonly<Record<string, AnswerKey>> = {
  "01": supplierInvoices,
  "02": customerTickets,
  "04": mortgageApplication,
  "05": insuranceClaim,
};

/** The keys of the hidden test set, by id. */
export const hiddenKeyIds: readonly string[] = ["03", "06"];

/** The repository's root: nothing hidden may be kept under it. */
export const repoRoot = path.resolve(import.meta.dirname, "../../..");

/** Why the hidden set can't be read. */
export class HiddenSetError extends Error {
  override name = "HiddenSetError";
}

/**
 * The folder the hidden set is kept in, from `LAB_HIDDEN`. It must be
 * outside the repository, so nothing of it is ever committed.
 */
export const hiddenFolder = (
  named: string | undefined = process.env.LAB_HIDDEN
): string => {
  if (named === undefined || named === "") {
    throw new HiddenSetError(
      "The hidden test set is kept outside the repository: name its folder with LAB_HIDDEN."
    );
  }
  const folder = path.resolve(named);
  const fromRoot = path.relative(repoRoot, folder);
  if (!(fromRoot.startsWith("..") || path.isAbsolute(fromRoot))) {
    throw new HiddenSetError(
      `LAB_HIDDEN is inside the repository (${folder}): keep the hidden test set outside it.`
    );
  }
  return folder;
};

export const isHidden = (id: string): boolean => hiddenKeyIds.includes(id);

/** A key of the hidden test set, for a run that only reports its scores. */
const hiddenKey = (id: string): AnswerKey => {
  const file = path.join(hiddenFolder(), "keys", `${id}.json`);
  if (!existsSync(file)) {
    throw new HiddenSetError(`There is no hidden key ${id} at ${file}.`);
  }
  const parsed = answerKeySchema.safeParse(
    JSON.parse(readFileSync(file, "utf-8"))
  );
  if (!parsed.success) {
    // Which fields, never what they hold: nobody reads a hidden key.
    throw new HiddenSetError(
      `Hidden key ${id} can't be read: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}.`
    );
  }
  return parsed.data;
};

/** Any key by id, hidden or not; `undefined` for an id that is neither. */
export const keyOf = (id: string): AnswerKey | undefined => {
  if (isHidden(id)) {
    return hiddenKey(id);
  }
  return openKeys[id];
};
