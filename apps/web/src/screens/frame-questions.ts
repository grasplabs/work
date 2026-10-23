import { decisionErrors } from "@grasp-os/shared/decisions";

import type { PendingConfirmation } from "../decision-confirmation.tsx";

// The answers one frame's screen asks the person to confirm, in Grasp's
// own dialog outside the frame (decision-confirmation.tsx): pure logic,
// so tested on its own.
//
// - One question at a time, on the whole page: a screen can't stack them
//   up behind each other or behind another frame's, and one asked while
//   another waits is refused. A decision's answer and a link to open go
//   through the same gate.
// - Each question is settled only by its own dialog: an answer meant for
//   one never confirms another that took its place.
// - A screen can't keep the person behind the dialog by asking again
//   whenever they cancel: after a cancel, it is refused for a while
//   (`cancelPauseMs`); after a second, until the screen is loaded again.
// - Once the frame stops, its question waiting ends unconfirmed, and none
//   it asks later is shown.

/** How long a screen's questions are refused after the person cancels one. */
export const cancelPauseMs = 5000;

/** Cancels after which a screen asks nothing more until it is reloaded. */
export const cancelsUntilReload = 2;

/** A question waiting in the dialog, and how its own dialog ends it. */
export interface Asked<Review = PendingConfirmation> {
  review: Review;
  settle: (confirmed: boolean) => void;
}

export interface FrameQuestions<Review = PendingConfirmation> {
  /**
   * Asks the person to confirm `review`; whether they did. Refused with
   * `paused` (for a decision `decision.asking_paused`) while another
   * question waits, after a cancel for a while, after two until reload,
   * and once the frame stopped.
   */
  confirm: (review: Review) => Promise<boolean>;
  /** The frame stopped: its question waiting ends unconfirmed. */
  end: () => void;
}

const decisionPaused = () => decisionErrors.create("decision.asking_paused");

/**
 * Whether any frame on the page has a question waiting: Grasp shows one
 * dialog at a time, so a screen can't stack one behind another frame's.
 */
export interface PageQuestions {
  waiting: number;
}

/** The page's own questions, every frame's together. */
const pageQuestions: PageQuestions = { waiting: 0 };

/**
 * One frame's questions (a decision's answers and links to open, through
 * one gate), shown with `show`; refused with `paused` for what was asked
 * while they may not be, or while another frame's question waits on
 * `page`.
 */
export const frameQuestions = <Review = PendingConfirmation>(
  show: (asked: Asked<Review> | null) => void,
  now: () => number = Date.now,
  paused: (review: Review) => Error = decisionPaused,
  page: PageQuestions = pageQuestions
): FrameQuestions<Review> => {
  let live = true;
  let waiting: ((confirmed: boolean) => void) | undefined;
  let cancels = 0;
  let pausedUntil = 0;
  return {
    confirm: async (review) => {
      if (
        !live ||
        waiting !== undefined ||
        page.waiting > 0 ||
        cancels >= cancelsUntilReload ||
        now() < pausedUntil
      ) {
        throw paused(review);
      }
      const { promise, resolve } = Promise.withResolvers<boolean>();
      waiting = resolve;
      page.waiting += 1;
      const settle = (confirmed: boolean): void => {
        // Only this question's own dialog ends it.
        if (waiting !== resolve) {
          return;
        }
        waiting = undefined;
        page.waiting -= 1;
        if (!confirmed) {
          cancels += 1;
          pausedUntil = now() + cancelPauseMs;
        }
        show(null);
        resolve(confirmed);
      };
      show({ review, settle });
      return await promise;
    },
    end: () => {
      live = false;
      const ending = waiting;
      if (ending !== undefined) {
        waiting = undefined;
        page.waiting -= 1;
        show(null);
        ending(false);
      }
    },
  };
};
