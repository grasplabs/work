import type { Roster } from "@grasp-os/shared/onboarding";

import type { SendChoice } from "./send-plan.ts";

// What the setup keeps of a visit, from step to step: what the admin
// changed on a step and didn't save yet, so it is as they left it, or that
// they confirmed it. Kept while the page is open.

/** What a step made of what core had (`from`), changed and not saved yet. */
interface Draft<T> {
  from: string;
  draft: T;
}

/** Where one step keeps what was changed on it and not saved yet. */
interface DraftSlot<T> {
  /** Keeps it, with what core had when it was made. */
  keep: (from: string, draft: T) => void;
  /** What was changed, as long as core still has what it was made from; else none. */
  of: (from: string) => T | undefined;
}

const draftSlot = <T>(): DraftSlot<T> => {
  let kept: Draft<T> | null = null;
  return {
    keep: (from, draft) => {
      kept = { from, draft };
    },
    of: (from) => (kept?.from === from ? kept.draft : undefined),
  };
};

/** Who leads which team and which take part, being confirmed. */
export const orgDraft = draftSlot<Roster>();

/** That the organization was confirmed as core has it, on this page: coming back to it, it still stands confirmed. */
export const orgConfirmed = draftSlot<true>();

/** When the interviews start, being chosen. */
export const planDraft = draftSlot<SendChoice>();
