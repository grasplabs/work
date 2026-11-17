import { factRevision } from "@grasp-os/shared/interview-links";
import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import type { InterviewKind, Interviewer } from "@grasp-os/shared/onboarding";
import { useSyncExternalStore } from "react";

import { approveFacts, isRefused, saveProgress } from "./api.ts";
import { freshProgress } from "./progress.ts";

// Someone's interview as this page holds it, kept in core after every
// change (`/api/interview`, action `save`): shortly after it, one save at a
// time, each of the version it goes on from. So "Stop for now", a reload,
// another tab or a closed window all carry on where it was. A copy that
// went stale (another tab saved meanwhile) takes the one core kept, and
// says so. Ported from the prototype (grasplabs/prototype, packages/grasp:
// src/data/interviews.ts, `openOwnLink` and `saveOwn`).
//
// Agreeing to the read-back is its own call (`approve`, GRA-329), once what
// was read back is kept: it names each fact at the revision they saw, so
// only exactly that counts. Asked again until core answers, it answers the
// same receipt; when core keeps another copy, that one is read back again.

/**
 * Where what they said stands: kept, on its way, not kept yet and tried
 * again, replaced by the copy kept from elsewhere, or refused for good.
 * They see it, so nobody thinks an answer is kept when it isn't.
 */
export type SaveState =
  | { state: "saved" | "saving" | "retrying" | "elsewhere" }
  | { state: "refused"; message: string };

interface Kept {
  secret: string;
  /** Whose interview it is: their own work, or a lead's about their team. */
  kind: InterviewKind;
  version: number;
  progress: InterviewProgress;
  /**
   * The interview as core is known to hold it: as it opened, then as each
   * save core kept, once what was to be approved with it was approved too.
   * What the page shows as done (where a line goes) is read from this,
   * never from `progress`, which holds what was asked for (GRA-1987).
   */
  held: InterviewProgress;
  /** A save on its way, and whether a change came in meanwhile. */
  saving: boolean;
  /**
   * This page, as its saves name it, and how many it sent: core takes a
   * later save of the page over a version an earlier one made that the
   * page never heard of (its answer lost, or on its way as it closed).
   */
  page: { id: string; saves: number };
  again: boolean;
  /** Something changed that isn't kept yet. */
  dirty: boolean;
  waiting: number | undefined;
  failed: number;
  /** Nothing more is saved: deleted, or refused for good. */
  gone: boolean;
  /** They agreed to the read-back, and core is to be told once it is kept. */
  approving: boolean;
  /**
   * The facts to approve then, by id: those they agreed to just now. Null
   * for every fact not taken out, as agreeing to the read-back does.
   */
  approvingOnly: ReadonlySet<string> | null;
}

/** How soon after a change it is kept: changes close together are kept together. */
const keepAfterMs = 400;
/** A save that is quick passes unseen: only one that takes this long says "Saving…". */
const showSavingAfterMs = 900;

/** How long to wait before a save is tried again: longer each time, never more than half a minute. */
export const retryAfter = (failed: number): number =>
  Math.min(30_000, 1000 * 2 ** Math.min(failed, 5));

let kept: Kept | null = null;
let saveState: SaveState = { state: "saved" };
let showingSaving: number | undefined;
const listeners = new Set<() => void>();
/** Told when the copy kept elsewhere took the place of this one. */
const takers = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const setSaveState = (next: SaveState): void => {
  window.clearTimeout(showingSaving);
  saveState = next;
  notify();
};

/** The interview as it is right now, for what runs outside a render. */
export const progressNow = (): InterviewProgress =>
  kept?.progress ?? freshProgress;

/** The link this page holds, while it holds one. */
export const linkNow = (): { secret: string } | null =>
  kept === null ? null : { secret: kept.secret };

/** The page as the next save names it (`page`): its next count. */
const nextSave = (mine: Kept): { id: string; save: number } => {
  mine.page.saves += 1;
  return { id: mine.page.id, save: mine.page.saves };
};

const saveOnce = async (mine: Kept): Promise<void> => {
  mine.dirty = false;
  const sent = mine.progress;
  const answer = await saveProgress({
    action: "save",
    secret: mine.secret,
    version: mine.version,
    progress: sent,
    page: nextSave(mine),
  });
  if (kept !== mine || mine.gone) {
    return;
  }
  if (isRefused(answer)) {
    const passing =
      answer.status === 0 || answer.status === 429 || answer.status >= 500;
    if (passing) {
      // It waits here and is tried again, and the screen says so.
      mine.dirty = true;
      mine.failed += 1;
      setSaveState({ state: "retrying" });
    } else {
      mine.gone = true;
      setSaveState({ state: "refused", message: answer.message });
    }
    return;
  }
  mine.failed = 0;
  mine.version = answer.version;
  if (answer.saved) {
    if (!mine.approving) {
      mine.held = sent;
    }
    if (mine.dirty) {
      notify();
    } else {
      setSaveState({ state: "saved" });
    }
    return;
  }
  if (answer.progress === null) {
    // Nothing kept to go on from: this copy is kept on top.
    mine.dirty = true;
    return;
  }
  // Another copy went on meanwhile: that one is the interview now.
  mine.progress = answer.progress;
  mine.held = answer.progress;
  mine.dirty = false;
  setSaveState({ state: "elsewhere" });
  for (const taker of takers) {
    taker();
  }
};

/** Tells core they approve the facts read back, as kept now: each at its revision. */
const approveOnce = async (mine: Kept): Promise<void> => {
  const approving = mine.progress;
  const only = mine.approvingOnly;
  const facts = await Promise.all(
    mine.progress.facts
      .filter(({ id, out }) => out !== true && (only === null || only.has(id)))
      .map(async (fact) => ({
        id: fact.id,
        revision: await factRevision(fact),
      }))
  );
  if (facts.length === 0) {
    mine.approving = false;
    return;
  }
  const answer = await approveFacts(mine.secret, facts);
  if (kept !== mine || mine.gone) {
    return;
  }
  if (isRefused(answer)) {
    const passing =
      answer.status === 0 || answer.status === 429 || answer.status >= 500;
    if (passing) {
      mine.failed += 1;
      setSaveState({ state: "retrying" });
      mine.waiting = window.setTimeout(() => {
        // oxlint-disable-next-line no-use-before-define -- tried again as a save is
        void save(mine);
      }, retryAfter(mine.failed));
    } else {
      mine.approving = false;
      setSaveState({ state: "refused", message: answer.message });
    }
    return;
  }
  mine.approving = false;
  mine.failed = 0;
  if (answer.approved) {
    mine.held = approving;
    setSaveState({ state: "saved" });
    return;
  }
  // What was read back isn't what core keeps: its copy is the interview
  // now, and what isn't approved in it is read back again.
  mine.version = answer.version;
  if (answer.progress !== null) {
    mine.progress = answer.progress;
    mine.held = answer.progress;
    setSaveState({ state: "elsewhere" });
    for (const taker of takers) {
      taker();
    }
  }
};

/** Saves now, one at a time; a change made meanwhile is saved right after. */
const save = async (mine: Kept): Promise<void> => {
  window.clearTimeout(mine.waiting);
  if (mine.gone) {
    return;
  }
  if (mine.saving) {
    mine.again = true;
    return;
  }
  mine.saving = true;
  try {
    // Once all is kept, what they agreed to goes.
    await (mine.approving && !(mine.dirty || mine.again)
      ? approveOnce(mine)
      : saveOnce(mine));
  } finally {
    mine.saving = false;
  }
  if (
    kept === mine &&
    !mine.gone &&
    mine.approving &&
    !(mine.again || mine.dirty) &&
    mine.failed === 0
  ) {
    void save(mine);
    return;
  }
  if (kept === mine && !mine.gone && (mine.again || mine.dirty)) {
    mine.again = false;
    mine.waiting = window.setTimeout(
      () => {
        void save(mine);
      },
      mine.failed > 0 ? retryAfter(mine.failed) : keepAfterMs
    );
  }
};

/** What is not kept yet goes now: they stop, agree, or the page goes. */
export const keepNow = (): void => {
  if (kept !== null && kept.dirty) {
    void save(kept);
  }
};

/**
 * Tries what isn't kept yet again now, as they asked, instead of waiting
 * for the next try: nothing when nothing waits, or saving stopped for good.
 */
export const saveAgainNow = (): void => {
  if (kept === null || kept.gone || !(kept.dirty || kept.approving)) {
    return;
  }
  kept.failed = 0;
  setSaveState({ state: "saving" });
  void save(kept);
};

/** They agreed to the read-back: core is told, once what was read back is kept. */
export const approveWhenKept = (only?: readonly string[]): void => {
  if (kept === null || kept.gone) {
    return;
  }
  kept.approving = true;
  kept.approvingOnly = only === undefined ? null : new Set(only);
  void save(kept);
};

/** Whose interview the page holds: their own work's, or a lead's; theirs before one is held. */
export const kindNow = (): InterviewKind => kept?.kind ?? "own";

/** The page goes: what is not kept yet goes with it, however it closes. */
const onPageHide = (): void => {
  const mine = kept;
  // A save on its way may be cut off with the page: it goes again, kept alive.
  if (mine === null || mine.gone || !(mine.dirty || mine.saving)) {
    return;
  }
  mine.dirty = false;
  // A save of the page's may have landed already, its answer lost or on
  // its way, and moved the version on past this page's: this one goes on
  // from it, as core takes the page's later saves (`page`). Counted too,
  // so a page brought back from the back/forward cache goes on from it.
  void saveProgress(
    {
      action: "save",
      secret: mine.secret,
      version: mine.version,
      progress: mine.progress,
      page: nextSave(mine),
    },
    { keepalive: true }
  );
};

/** The interview core holds for this link, from now on held here. */
export const holdInterview = ({
  secret,
  kind,
  version,
  progress,
}: {
  secret: string;
  kind: InterviewKind;
  version: number;
  progress: InterviewProgress | null;
}): void => {
  if (kept !== null) {
    window.clearTimeout(kept.waiting);
  }
  kept = {
    secret,
    kind,
    version,
    progress: progress ?? freshProgress,
    held: progress ?? freshProgress,
    saving: false,
    page: { id: crypto.randomUUID(), saves: 0 },
    again: false,
    dirty: false,
    waiting: undefined,
    failed: 0,
    gone: false,
    approving: false,
    approvingOnly: null,
  };
  saveState = { state: "saved" };
  window.removeEventListener("pagehide", onPageHide);
  window.addEventListener("pagehide", onPageHide);
  notify();
};

/** The page lets the interview go: nothing more is saved from it. */
export const releaseInterview = (): void => {
  if (kept !== null) {
    window.clearTimeout(kept.waiting);
  }
  kept = null;
  window.removeEventListener("pagehide", onPageHide);
  notify();
};

/** Moves the interview on, and keeps it shortly after. */
export const update = (
  change: (progress: InterviewProgress) => InterviewProgress
): void => {
  const mine = kept;
  if (mine === null || mine.gone) {
    return;
  }
  const next = change(mine.progress);
  if (next === mine.progress) {
    return;
  }
  mine.progress = next;
  mine.dirty = true;
  notify();
  window.clearTimeout(mine.waiting);
  mine.waiting = window.setTimeout(() => {
    void save(mine);
  }, keepAfterMs);
  // A quick save passes unseen; one that takes long is shown.
  if (saveState.state === "saved" || saveState.state === "elsewhere") {
    window.clearTimeout(showingSaving);
    showingSaving = window.setTimeout(() => {
      setSaveState({ state: "saving" });
    }, showSavingAfterMs);
  }
};

/** They deleted it: nothing more goes to core, so no save waiting here brings it back. */
export const forgetInterview = (): void => {
  if (kept !== null) {
    kept.gone = true;
    window.clearTimeout(kept.waiting);
  }
  window.clearTimeout(showingSaving);
};

/** Tells `taker` whenever the copy kept elsewhere takes this one's place. */
export const onTaken = (taker: () => void): (() => void) => {
  takers.add(taker);
  return () => {
    takers.delete(taker);
  };
};

/** The interview, as the page shows it. */
export const useProgress = (): InterviewProgress =>
  useSyncExternalStore(subscribe, progressNow);

/** Whose interview the page holds (`kindNow`). */
export const useKind = (): InterviewKind =>
  useSyncExternalStore(subscribe, kindNow);

/** The interview as core is known to hold it (`Kept.held`). */
export const useHeld = (): InterviewProgress =>
  useSyncExternalStore(subscribe, () => kept?.held ?? freshProgress);

/** Where saving stands. */
export const useSaveState = (): SaveState =>
  useSyncExternalStore(subscribe, () => saveState);

/** Who holds the interview: whoever they chose, Stephen while nobody was chosen. */
export const useInterviewer = (): Interviewer =>
  useSyncExternalStore(subscribe, () => progressNow().interviewer ?? "stephen");
