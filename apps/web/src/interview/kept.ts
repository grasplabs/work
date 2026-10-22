import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import { useSyncExternalStore } from "react";

import { isRefused, saveProgress } from "./api.ts";
import { freshProgress } from "./progress.ts";

// Someone's interview as this page holds it, kept in core after every
// change (`/api/interview`, action `save`): shortly after it, one save at a
// time, each of the version it goes on from. So "Stop for now", a reload,
// another tab or a closed window all carry on where it was. A copy that
// went stale (another tab saved meanwhile) takes the one core kept, and
// says so. Ported from the prototype (grasplabs/prototype, packages/grasp:
// src/data/interviews.ts, `openOwnLink` and `saveOwn`).

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
  key: string;
  version: number;
  progress: InterviewProgress;
  /** A save on its way, and whether a change came in meanwhile. */
  saving: boolean;
  again: boolean;
  /** Something changed that isn't kept yet. */
  dirty: boolean;
  waiting: number | undefined;
  failed: number;
  /** Nothing more is saved: deleted, or refused for good. */
  gone: boolean;
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

/** The link and key this page holds, while it holds one. */
export const linkNow = (): { secret: string; key: string } | null =>
  kept === null ? null : { secret: kept.secret, key: kept.key };

const saveOnce = async (mine: Kept): Promise<void> => {
  mine.dirty = false;
  const sent = mine.progress;
  const answer = await saveProgress({
    action: "save",
    secret: mine.secret,
    key: mine.key,
    version: mine.version,
    progress: sent,
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
    if (!mine.dirty) {
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
  mine.dirty = false;
  setSaveState({ state: "elsewhere" });
  for (const taker of takers) {
    taker();
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
    await saveOnce(mine);
  } finally {
    mine.saving = false;
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

/** The page goes: what is not kept yet goes with it, however it closes. */
const onPageHide = (): void => {
  const mine = kept;
  // A save on its way may be cut off with the page: it goes again, kept alive.
  if (mine === null || mine.gone || !(mine.dirty || mine.saving)) {
    return;
  }
  mine.dirty = false;
  void saveProgress(
    {
      action: "save",
      secret: mine.secret,
      key: mine.key,
      version: mine.version,
      progress: mine.progress,
    },
    { keepalive: true }
  );
};

/** The interview core holds for this link and device, from now on held here. */
export const holdInterview = ({
  secret,
  key,
  version,
  progress,
}: {
  secret: string;
  key: string;
  version: number;
  progress: InterviewProgress | null;
}): void => {
  if (kept !== null) {
    window.clearTimeout(kept.waiting);
  }
  kept = {
    secret,
    key,
    version,
    progress: progress ?? freshProgress,
    saving: false,
    again: false,
    dirty: false,
    waiting: undefined,
    failed: 0,
    gone: false,
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

/** Where saving stands. */
export const useSaveState = (): SaveState =>
  useSyncExternalStore(subscribe, () => saveState);
