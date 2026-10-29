import type { OnErase } from "@grasp-os/brain/purge";
import { auditActorSchema } from "@grasp-os/shared/audit";
import {
  stephenLimitMaxLength,
  stephenSetupSchema,
  stephenTermMaxLength,
} from "@grasp-os/shared/onboarding-staff";

import { jsonOf, rewrittenStored, storedTexts } from "./interview-erasure.ts";
import { onboardingStore } from "./store.ts";

// Grasp's staff's own text in the onboarding as a Knowledge purge reaches
// it (GRA-1126): their notes, and how Stephen is set up. A purge is the
// admin's hard delete, and staff may have typed what it takes out (a
// name, an address). Only a purge of terms reaches it (`rewrite`): every
// string in it is rewritten where it holds one. A purge naming a document
// (`forgetDocuments`) never does: staff wrote it, it wasn't read from the
// document, so it isn't the document's copy. It names no one by an id,
// so a personal purge has no one to forget here.

/** How often a purge reads staff's text again that was saved as it rewrote it. */
const rewriteAttempts = 5;

/**
 * Lines rewritten as a setup keeps them: none emptied, none twice, none
 * longer than `max` (`stephenSetupSchema`).
 */
const rewrittenLines = (
  lines: readonly string[],
  rewrite: (text: string) => string,
  max: number
): string[] => [
  ...new Set(
    lines
      .map((line) => rewrite(line).slice(0, max).trim())
      .filter((line) => line !== "")
  ),
];

/**
 * Stephen's setup as stored, rewritten: its lines (what he leaves alone,
 * the words he has to know), each kept as a setup keeps lines, so it
 * still reads as a setup; his languages are codes, never words. One that
 * no longer reads as a setup has every string in it rewritten.
 */
const rewrittenSetup = (
  stored: string,
  rewrite: (text: string) => string
): string => {
  const parsed = stephenSetupSchema.safeParse(jsonOf(stored));
  if (!parsed.success) {
    return rewrittenStored(stored, rewrite);
  }
  const { languages, limits, terms } = parsed.data;
  const after = {
    languages,
    limits: rewrittenLines(limits, rewrite, stephenLimitMaxLength),
    terms: rewrittenLines(terms, rewrite, stephenTermMaxLength),
  };
  return JSON.stringify(after) === JSON.stringify(parsed.data)
    ? stored
    : JSON.stringify(after);
};

/**
 * The texts of Stephen's setup a purge looks in: exactly those it rewrites
 * (`rewrittenSetup`), its lines, never his language codes; every string of
 * one that no longer reads as a setup. So a count never finds left what a
 * rewrite would never take out.
 */
const setupTexts = (stored: string): string[] => {
  const parsed = stephenSetupSchema.safeParse(jsonOf(stored));
  return parsed.success
    ? [...parsed.data.limits, ...parsed.data.terms]
    : storedTexts(stored);
};

/** Every text a purge looks in of `said` (the store's `staffTextsSaid`). */
const textsOf = (said: {
  notes: readonly { text: string }[];
  setup: string | null;
}): string[] => [
  ...said.notes.map(({ text }) => text),
  ...(said.setup === null ? [] : setupTexts(said.setup)),
];

/** Staff's notes and Stephen's setup, as a purge of terms reaches them. */
export const staffTextErasure = (
  env: Pick<Env, "ONBOARDING" | "DURABLE_OBJECT_JURISDICTION">
): Pick<OnErase, "count" | "rewrite" | "forgetActor"> => {
  const store = onboardingStore(env);
  return {
    count: async (holds) => {
      const said = await store.staffTextsSaid();
      return (
        said.notes.filter(({ text }) => holds(text)).length +
        (said.setup !== null && setupTexts(said.setup).some(holds) ? 1 : 0)
      );
    },
    rewrite: async (by, rewrite) => {
      const actor = auditActorSchema.parse(by.actor);
      for (let attempt = 0; attempt < rewriteAttempts; attempt += 1) {
        // oxlint-disable-next-line no-await-in-loop -- read again only when it lost
        const said = await store.staffTextsSaid();
        if (!textsOf(said).some((text) => rewrite(text) !== text)) {
          return;
        }
        // oxlint-disable-next-line no-await-in-loop -- read again only when it lost
        const landed = await store.rewriteStaffTexts(
          said,
          {
            notes: said.notes.map(({ id, text }) => ({
              id,
              text: rewrite(text),
            })),
            setup:
              said.setup === null ? null : rewrittenSetup(said.setup, rewrite),
          },
          actor
        );
        if (landed) {
          return;
        }
      }
      throw new Error("Staff's text kept changing while the purge rewrote it");
    },
    forgetActor: async () => {
      // Staff's text names no one by an id.
    },
  };
};
