import {
  factRevision,
  interviewProgressSchema,
} from "@grasp-os/shared/interview-links";
import type {
  InterviewFact,
  InterviewProgress,
} from "@grasp-os/shared/interview-links";
import type { Interviewer } from "@grasp-os/shared/onboarding";
import { useSyncExternalStore } from "react";
import { z } from "zod";

import { approveFacts, isRefused, saveProgress } from "./api.ts";
import { freshProgress, notYetApproved, resumed } from "./progress.ts";

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
// page goes, until core opens the link again for a session. Until then the
// copy that isn't kept, and what is typed in the box, wait in this tab
// alone (`sessionStorage`, under the link's draft name, a hash of its
// secret). This is the one time an interview's words are put in the
// browser's storage, and only while something isn't kept. From the threat
// model:
//
// - Sent without a session, or under someone else's: nothing goes out
//   while set aside, and it is taken up again only as core opens the link,
//   which it does only for the account the link belongs to. When it opens
//   nothing (someone else signed in, or the interview is gone), what
//   waited is forgotten, not just hidden.
// - Undoing what happened meanwhile (a staff new start, a delete or a
//   withdrawal in another window, another window going on): a kept copy
//   only ever goes onto the version it was taken at, and onto an interview
//   that still takes saves. Otherwise core's copy is the interview, what
//   waited is forgotten, and the page says it couldn't be kept (`useLost`).
// - Approving what wasn't read back: an approval that hadn't reached core
//   is never sent by itself afterwards. They see the read-back again and
//   agree again. An approval names the facts as they stood when they
//   agreed (`Approval`), so core refuses it once any of them changed.
// - Repeating what can't be undone: a delete or a withdrawal that met the
//   ended session didn't happen and is never repeated by itself; nothing
//   unsaved is kept back before they can press it again, and the page
//   says it didn't happen (`useUndone`).
// - Kept anywhere but this tab: never in `localStorage`, the address, or
//   what the sign-in keeps. The tab's storage outlives the tab in places:
//   reopening a closed tab or restoring a session brings it back, and
//   duplicating the tab copies it. What waits is the whole interview, the
//   lines core already holds included, not only what isn't kept: a delta
//   could be rebuilt onto the version it was taken at, but would have to
//   say removals, fact edits and read-back progress as well as new lines,
//   a second save format. So it waits only while something isn't kept,
//   and is forgotten as soon as it can't be kept or core answered for it.
//   Where the tab refuses storage, the sign-in says what isn't saved is
//   lost.
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

/**
 * They agreed to the read-back, and core is to be told once it is kept:
 * the facts as they stood when they agreed, so only exactly those are
 * approved, however often it is asked; and the interview before, should
 * their session end before core was told.
 */
interface Approval {
  facts: InterviewFact[];
  before: InterviewProgress;
}

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
  approval: Approval | null;
  /** Where it waits in this tab while it is set aside (api.ts `draftName`). */
  draft: string;
  /** Their session ended: nothing more is sent until the link opens again. */
  aside: boolean;
  /** This tab refused to keep what waits. */
  unkept: boolean;
  /** What waited in this tab, held again, and core hasn't answered for it yet. */
  restoring: boolean;
  /** What is typed in the box and not sent. */
  typed: string;
  /** A delete or a withdrawal that met the ended session, and didn't happen. */
  undone: Undone | null;
}

/** What they asked for as their session ended, and didn't happen. */
export type Undone = "delete" | "withdraw";

/** Why what waited in this tab couldn't be kept: the interview changed, or closed. */
export type Lost = "changed" | "closed";

/** What waits in this tab while their session is ended, until the link opens again. */
const asideSchema = z.object({
  /** The version it goes on from: it is kept only onto that one. */
  version: z.int().min(0),
  /** What isn't kept yet; none when all of it is. */
  progress: interviewProgressSchema.nullable(),
  typed: z.string(),
  /** They were talking: a stretch said as it ended is lost. */
  talking: z.boolean(),
  undone: z.enum(["delete", "withdraw"]).nullable(),
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

/** Forgets what waited under `draft`: core answered for it, or it can't be kept. */
export const forgetAside = (draft: string): void => {
  try {
    sessionStorage.removeItem(draft);
  } catch {
    // Nothing was kept.
  }
};

/** Whether anything of `mine` isn't kept in core. */
const unsavedIn = (mine: Kept): boolean => mine.dirty || mine.typed !== "";

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
    talking: mine.progress.mode === "talk",
    undone: mine.undone,
  };
  try {
    sessionStorage.setItem(mine.draft, JSON.stringify(aside));
    mine.unkept = false;
  } catch {
    // Storage refused (a private window may): the sign-in says it is lost.
    mine.unkept = true;
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
/** Why what waited in this tab couldn't be kept, if it couldn't. */
let lostNow: Lost | null = null;
/** What they asked for as their session ended, and didn't happen. */
let undoneNow: Undone | null = null;
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

/**
 * The link this page holds, while it holds one and their session hasn't
 * ended: everything said on the link goes by it (turns, stories, lines
 * said, the ear), so nothing goes out while it is set aside, whatever
 * answer lands meanwhile.
 */
export const linkNow = (): { secret: string } | null =>
  kept === null || kept.aside ? null : { secret: kept.secret };

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
      // Refused for good: nothing of it waits in this tab either.
      mine.gone = true;
      forgetAside(mine.draft);
      setSaveState({ state: "refused", message: answer.message });
    }
    return;
  }
  mine.failed = 0;
  if (mine.aside) {
    // Landed just before their session ended: what waits goes on from it,
    // and is only what changed since. Not kept: it waits at the version it
    // went on from, and core's copy decides once they are back.
    if (answer.saved) {
      mine.version = answer.version;
      mine.dirty = mine.progress !== sent;
    } else {
      mine.dirty = true;
    }
    keepAside(mine);
    return;
  }
  mine.version = answer.version;
  const { restoring } = mine;
  mine.restoring = false;
  // Core answered for what waited in this tab, if anything did.
  forgetAside(mine.draft);
  if (answer.saved) {
    if (!mine.dirty) {
      setSaveState({ state: "saved" });
    }
    return;
  }
  if (restoring) {
    // What waited goes only onto the version it was taken at, and core
    // changed meanwhile: its copy is the interview, even when it holds
    // none (a new start), and the page says what waited couldn't be kept.
    mine.progress = resumed(answer.progress ?? freshProgress);
    mine.dirty = false;
    mine.typed = "";
    lostNow = "changed";
    notify();
    for (const taker of takers) {
      taker();
    }
    return;
  }
  if (answer.progress === null) {
    // Nothing kept to go on from: this copy is kept on top.
    mine.dirty = true;
    return;
  }
  // Another copy went on meanwhile: that one is the interview now, and
  // what they agreed to here is read back again from it.
  mine.progress = answer.progress;
  mine.dirty = false;
  mine.approval = null;
  setSaveState({ state: "elsewhere" });
  for (const taker of takers) {
    taker();
  }
};

/** Tells core they approve the facts as they stood when they agreed: each at its revision. */
const approveOnce = async (mine: Kept): Promise<void> => {
  const { approval } = mine;
  if (approval === null) {
    return;
  }
  const facts = await Promise.all(
    approval.facts.map(async (fact) => ({
      id: fact.id,
      revision: await factRevision(fact),
    }))
  );
  if (facts.length === 0) {
    mine.approval = null;
    return;
  }
  if (kept !== mine || mine.gone || mine.aside) {
    // Their session ended while it was made: never sent (`setAside`).
    return;
  }
  const answer = await approveFacts(mine.secret, facts);
  if (kept !== mine || mine.gone || mine.aside) {
    // Answered after their session ended: it changes nothing, here or in
    // what waits in this tab, and nothing goes out for it.
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
      mine.approval = null;
      setSaveState({ state: "refused", message: answer.message });
    }
    return;
  }
  mine.approval = null;
  mine.failed = 0;
  if (answer.approved) {
    setSaveState({ state: "saved" });
    return;
  }
  // What was read back isn't what core keeps: its copy is the interview
  // now, and what isn't approved in it is read back again.
  mine.version = answer.version;
  if (answer.progress !== null) {
    mine.progress = answer.progress;
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
    await (mine.approval !== null && !(mine.dirty || mine.again)
      ? approveOnce(mine)
      : saveOnce(mine));
  } finally {
    mine.saving = false;
  }
  if (
    kept === mine &&
    !mine.gone &&
    mine.approval !== null &&
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
 * They agreed to the read-back, as it now stands (`before` is how it stood
 * before they agreed): core is told, once what was read back is kept.
 */
export const approveWhenKept = (before: InterviewProgress): void => {
  if (kept === null || kept.gone) {
    return;
  }
  kept.approval = {
    facts: kept.progress.facts.filter(({ out }) => out !== true),
    before,
  };
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
 * The interview core holds for this link, at `version`, from now on held
 * here. Back after their session ended, what waited in this tab under
 * `draft` is held instead and kept at once, but only onto the version it
 * was taken at, and only while the interview takes saves (not `withdrawn`,
 * not `closed`). Otherwise core's copy is the interview, and the page says
 * what waited couldn't be kept. Whatever isn't held is forgotten, also
 * what no longer reads as a kept copy. Back on the link after stopping,
 * either carries on where it was.
 */
export const holdInterview = ({
  secret,
  draft,
  version,
  progress,
  withdrawn,
  closed,
}: {
  secret: string;
  draft: string;
  version: number;
  progress: InterviewProgress | null;
  withdrawn: boolean;
  closed: boolean;
}): void => {
  if (kept !== null) {
    window.clearTimeout(kept.waiting);
  }
  const aside = asideAt(draft);
  const unchanged = aside !== null && aside.version === version;
  const usable = unchanged && !withdrawn && !closed;
  const unsaved = usable ? aside.progress : null;
  const mine: Kept = {
    secret,
    version,
    progress: resumed(unsaved ?? progress ?? freshProgress),
    saving: false,
    again: false,
    dirty: unsaved !== null,
    waiting: undefined,
    failed: 0,
    gone: false,
    approval: null,
    draft,
    aside: false,
    unkept: false,
    restoring: unsaved !== null,
    typed: usable ? aside.typed : "",
    undone: null,
  };
  kept = mine;
  const dropped =
    aside !== null &&
    !usable &&
    (aside.progress !== null || aside.typed !== "");
  lostNow = null;
  if (dropped) {
    lostNow = closed ? "closed" : "changed";
  }
  // What they asked for didn't happen, unless the interview changed since.
  undoneNow = unchanged ? aside.undone : null;
  saveState = { state: "saved" };
  window.removeEventListener("pagehide", onPageHide);
  window.addEventListener("pagehide", onPageHide);
  notify();
  if (mine.dirty) {
    void save(mine);
  } else {
    // Nothing to keep, it can't be, or it no longer reads as a kept copy:
    // only what was typed, in the box again.
    forgetAside(draft);
  }
};

/**
 * Their session ended: nothing more is sent, and whatever isn't kept yet
 * waits in this tab until the link opens again (`holdInterview`). A save
 * on its way may still have landed; it waits all the same, and is kept
 * again as of what core answered. An approval core wasn't told of is
 * never sent by itself afterwards: the read-back as it stood before waits
 * instead, to agree to again.
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
  if (mine.approval !== null) {
    mine.progress = notYetApproved(mine.approval.before);
    mine.dirty = true;
    mine.approval = null;
  }
  keepAside(mine);
};

/**
 * They asked to delete their interview, or to withdraw, just as their
 * session ended: it didn't happen, and nothing unsaved waits to be kept
 * again before they can ask again once back, where the page says so.
 */
export const forgetUnsaved = (asked: Undone): void => {
  const mine = kept;
  if (mine === null || !mine.aside) {
    return;
  }
  mine.dirty = false;
  mine.typed = "";
  mine.undone = asked;
  keepAside(mine);
};

/**
 * Whether their session ended with something waiting under `draft`;
 * `talking`: they were talking as it ended; `unkept`: this tab refused to
 * keep what wasn't saved, so it is lost; `undone`: a delete or withdrawal
 * they asked for as it ended, which didn't happen, and what wasn't saved
 * was let go for it.
 */
export const waitingAside = (
  draft: string
): { talking: boolean; unkept: boolean; undone: Undone | null } | null => {
  const mine = kept;
  if (mine !== null && mine.aside && mine.draft === draft) {
    return {
      talking: mine.progress.mode === "talk",
      unkept: mine.unkept && unsavedIn(mine),
      undone: mine.undone,
    };
  }
  const aside = asideAt(draft);
  return aside === null
    ? null
    : { talking: aside.talking, unkept: false, undone: aside.undone };
};

/** The page lets the interview go: nothing more is saved from it. */
export const releaseInterview = (): void => {
  if (kept !== null) {
    window.clearTimeout(kept.waiting);
  }
  kept = null;
  lostNow = null;
  undoneNow = null;
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

/** Why what waited in this tab while their session was ended couldn't be kept, if it couldn't. */
export const useLost = (): Lost | null =>
  useSyncExternalStore(subscribe, () => lostNow);

/** A delete or a withdrawal that met their ended session, and didn't happen. */
export const useUndone = (): Undone | null =>
  useSyncExternalStore(subscribe, () => undoneNow);

/** Who holds the interview: whoever they chose, Stephen while nobody was chosen. */
export const useInterviewer = (): Interviewer =>
  useSyncExternalStore(subscribe, () => progressNow().interviewer ?? "stephen");
