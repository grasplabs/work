import type { Roster } from "@grasp-os/shared/onboarding";

import type { SendChoice } from "./send-plan.ts";
import { isStep } from "./setup.ts";
import type { SetupStep } from "./setup.ts";

// What the onboarding keeps of a visit, from step to step. The steps
// Stephen finished, so coming back to one he doesn't say it again: kept
// in this tab for as long as it is open, so a step left for a sign-in and
// come back to, or the page drawn anew in another language, counts too.
// And what the admin changed on a step and didn't save yet, so it is as
// they left it: kept while the page is open.

/** Where this tab keeps the steps Stephen finished. */
const heardKey = "grasp.setup.heard";

const readHeard = (): SetupStep[] => {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(heardKey) ?? "[]");
    return Array.isArray(raw) ? raw.filter(isStep) : [];
  } catch {
    return [];
  }
};

/** The steps Stephen finished while this page is open: all there is where the tab refuses storage. */
const heardHere = new Set<SetupStep>();

/** Stephen finished saying `step`. */
export const noteHeard = (step: SetupStep): void => {
  heardHere.add(step);
  const heard = readHeard();
  if (heard.includes(step)) {
    return;
  }
  try {
    sessionStorage.setItem(heardKey, JSON.stringify([...heard, step]));
  } catch {
    // Storage refused: kept while the page is open.
  }
};

/** Whether Stephen finished saying `step` in this tab. */
export const wasHeard = (step: SetupStep): boolean =>
  heardHere.has(step) || readHeard().includes(step);

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

/** When the interviews start, being chosen. */
export const planDraft = draftSlot<SendChoice>();
