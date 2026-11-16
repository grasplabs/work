import {
  factRevision,
  interviewProgressSchema,
} from "@grasp-os/shared/interview-links";
import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import type { Interviewer } from "@grasp-os/shared/onboarding";
import { useSyncExternalStore } from "react";
import { z } from "zod";

import { approveFacts, isRefused, saveProgress } from "./api.ts";
import { freshProgress, resumed } from "./progress.ts";

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
//
// When their session ends mid-interview (the company's gate opens, they
// signed out in another tab, it expired: GRA-1943), whatever isn't kept
// yet is set aside (`setAside`): nothing more is sent, not even as the
// page goes, until core opens the link again for a session. Until then it
// waits in this tab alone (`sessionStorage`, under the link's draft name,
// a hash of its secret), and once the link opens again it is held, and
// kept, as it was: at the version it went on from, so a copy that went on
// elsewhere meanwhile is the interview, as ever. It is forgotten as soon
// as core answers a save of it. From the threat model:
//
// - Sent without a session, or under someone else's: nothing goes out
//   while set aside, and it is taken up again only as core opens the link,
//   which it does only for the account the link belongs to. Anyone else
//   is told the link opens nothing, and never sees it.
// - Kept anywhere but this tab: never in `localStorage`, the address, or
//   what the sign-in keeps; the tab's storage goes with the tab.
// - Audio: none is ever kept (ear.ts). What was written down of what they
//   said is in the interview already; a stretch said as it ended is lost,
//   and the sign-in says so before they speak again (`talking`).

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
  /** They agreed to the read-back, and core is to be told once it is kept. */
  approving: boolean;
  /** Where it waits in this tab while it is set aside (api.ts `draftName`). */
  draft: string;
  /** Their session ended: nothing more is sent until the link opens again. */
  aside: boolean;
  /** What is typed in the box and not sent. */
  typed: string;
}

/** What waits in this tab while their session is ended, until the link opens again. */
const asideSchema = z.object({
  version: z.int().min(0),
  /** What isn't kept yet; none when all of it is. */
  progress: interviewProgressSchema.nullable(),
  typed: z.string(),
  approving: z.boolean(),
  /** They were talking: a stretch said as it ended is lost. */
  talking: z.boolean(),
});
type Aside = z.output<typeof asideSchema>;

/** What waits under `draft`, if anything. */
const asideAt = (draft: string): Aside | null => {
  try {
    const raw = sessionStorage.getItem(draft);
    if (raw === null) {
      return null;
    }
    const parsed = asideSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** Whether something waits under `draft`, and whether they were talking as it ended. */
export const waitingAside = (draft: string): { talking: boolean } | null => {
  const aside = asideAt(draft);
  return aside === null ? null : { talking: aside.talking };
};

/** Forgets what waited under `draft`: core answered a save of it, or it is deleted. */
const forgetAside = (draft: string): void => {
  try {
    sessionStorage.removeItem(draft);
  } catch {
    // Nothing was kept.
  }
};

/**
 * Writes down what waits while set aside: also when all of it is kept, so
 * the page tells them they are signing in again.
 */
const keepAside = (mine: Kept): void => {
  if (!mine.aside) {
    return;
  }
  const aside: Aside = {
    version: mine.version,
    progress: mine.dirty ? mine.progress : null,
    typed: mine.typed,
    approving: mine.approving,
    talking: mine.progress.mode === "talk",
  };
  try {
    sessionStorage.setItem(mine.draft, JSON.stringify(aside));
  } catch {
    // Storage refused (a private window may): it lasts while this page does.
  }
};

/**
 * Core answered: what waited in this tab is forgotten, or, while their
 * session is ended, written down again as it now stands.
 */
const answeredAside = (mine: Kept): void => {
  if (mine.aside) {
    keepAside(mine);
  } else {
    forgetAside(mine.draft);
  }
};

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

const saveOnce = async (mine: Kept): Promise<void> => {
  mine.dirty = false;
  const sent = mine.progress;
  const answer = await saveProgress({
    action: "save",
    secret: mine.secret,
    version: mine.version,
    progress: sent,
  });
  if (kept !== mine || mine.gone) {
    return;
  }
  if (isRefused(answer)) {
    if (mine.aside) {
      // Their session ended: it waits for them to sign in again.
      mine.dirty = true;
      keepAside(mine);
      return;
    }
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
  if (mine.aside) {
    // Landed just before their session ended: what waits goes on from it,
    // and is only what changed since; a copy kept elsewhere takes its place.
    if (answer.saved) {
      mine.dirty = mine.progress !== sent;
    } else if (answer.progress !== null) {
      mine.progress = answer.progress;
      mine.dirty = false;
    }
    keepAside(mine);
    return;
  }
  // Core answered for what waited in this tab, if anything did.
  forgetAside(mine.draft);
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

/** Tells core they approve the facts read back, as kept now: each at its revision. */
const approveOnce = async (mine: Kept): Promise<void> => {
  const facts = await Promise.all(
    mine.progress.facts
      .filter(({ out }) => out !== true)
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
  if (isRefused(answer) && mine.aside) {
    // Their session ended: core is told once they are back.
    keepAside(mine);
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
  answeredAside(mine);
  if (answer.approved) {
    setSaveState({ state: "saved" });
    return;
  }
  // What was read back isn't what core keeps: its copy is the interview
  // now, and what isn't approved in it is read back again.
  mine.version = answer.version;
  if (answer.progress !== null) {
    mine.progress = answer.progress;
    answeredAside(mine);
    setSaveState({ state: "elsewhere" });
    for (const taker of takers) {
      taker();
    }
  }
};

/** Saves now, one at a time; a change made meanwhile is saved right after. */
const save = async (mine: Kept): Promise<void> => {
  window.clearTimeout(mine.waiting);
  if (mine.gone || mine.aside) {
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
  if (mine.aside) {
    return;
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

/** They agreed to the read-back: core is told, once what was read back is kept. */
export const approveWhenKept = (): void => {
  if (kept === null || kept.gone) {
    return;
  }
  kept.approving = true;
  void save(kept);
};

/** The page goes: what is not kept yet goes with it, however it closes. */
const onPageHide = (): void => {
  const mine = kept;
  // A save on its way may be cut off with the page: it goes again, kept alive.
  if (
    mine === null ||
    mine.gone ||
    mine.aside ||
    !(mine.dirty || mine.saving)
  ) {
    return;
  }
  mine.dirty = false;
  void saveProgress(
    {
      action: "save",
      secret: mine.secret,
      version: mine.version,
      progress: mine.progress,
    },
    { keepalive: true }
  );
};

/**
 * The interview core holds for this link, from now on held here; or, back
 * after their session ended, what waited in this tab under `draft`, kept
 * at once as of the version it went on from. Back on the link after
 * stopping, either carries on where it was.
 */
export const holdInterview = ({
  secret,
  draft,
  version,
  progress,
}: {
  secret: string;
  draft: string;
  version: number;
  progress: InterviewProgress | null;
}): void => {
  if (kept !== null) {
    window.clearTimeout(kept.waiting);
  }
  const aside = asideAt(draft);
  const unsaved = aside?.progress ?? null;
  const mine: Kept = {
    secret,
    version: unsaved === null ? version : (aside?.version ?? version),
    progress: resumed(unsaved ?? progress ?? freshProgress),
    saving: false,
    again: false,
    dirty: unsaved !== null,
    waiting: undefined,
    failed: 0,
    gone: false,
    approving: aside?.approving ?? false,
    draft,
    aside: false,
    typed: aside?.typed ?? "",
  };
  kept = mine;
  saveState = { state: "saved" };
  window.removeEventListener("pagehide", onPageHide);
  window.addEventListener("pagehide", onPageHide);
  notify();
  if (mine.dirty || mine.approving) {
    void save(mine);
  } else if (aside !== null) {
    // Nothing waited to be kept: what was typed is in the box again.
    forgetAside(draft);
  }
};

/**
 * Their session ended: nothing more is sent, and whatever isn't kept yet
 * waits in this tab until the link opens again (`holdInterview`). A save
 * on its way may still have landed; it waits all the same, and is kept
 * again as of what core answered.
 */
export const setAside = (): void => {
  const mine = kept;
  if (mine === null || mine.gone || mine.aside) {
    return;
  }
  window.clearTimeout(mine.waiting);
  window.clearTimeout(showingSaving);
  mine.aside = true;
  mine.dirty ||= mine.saving || mine.again;
  keepAside(mine);
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
  if (mine.aside) {
    // What they said as the conversation stopped waits with the rest.
    keepAside(mine);
    return;
  }
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
    forgetAside(kept.draft);
  }
  window.clearTimeout(showingSaving);
};

/** What is typed in the box and not sent: it outlasts the box, and waits with the rest while set aside. */
export const setTyped = (text: string): void => {
  const mine = kept;
  if (mine === null || mine.typed === text) {
    return;
  }
  mine.typed = text;
  notify();
  keepAside(mine);
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

/** What is typed in the box and not sent. */
export const useTyped = (): string =>
  useSyncExternalStore(subscribe, () => kept?.typed ?? "");

/** Who holds the interview: whoever they chose, Stephen while nobody was chosen. */
export const useInterviewer = (): Interviewer =>
  useSyncExternalStore(subscribe, () => progressNow().interviewer ?? "stephen");
