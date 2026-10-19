import { decisionErrors } from "@grasp-os/shared/decisions";

import type { PendingConfirmation } from "../decision-confirmation.tsx";

// The answers one frame's screen asks the person to confirm, in Grasp's
// own dialog outside the frame (decision-confirmation.tsx): pure logic,
// so tested on its own.
//
// - One question at a time: a screen can't stack them up behind each
//   other, and one asked while another waits is refused.
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
export interface Asked {
  review: PendingConfirmation;
  settle: (confirmed: boolean) => void;
}

export interface FrameQuestions {
  /**
   * Asks the person to confirm `review`; whether they did. Refused with
   * `decision.asking_paused` while another question waits, after a cancel
   * for a while, after two until reload, and once the frame stopped.
   */
  confirm: (review: PendingConfirmation) => Promise<boolean>;
  /** The frame stopped: its question waiting ends unconfirmed. */
  end: () => void;
}

const paused = () => decisionErrors.create("decision.asking_paused");

export const frameQuestions = (
  show: (asked: Asked | null) => void,
  now: () => number = Date.now
): FrameQuestions => {
  let live = true;
  let waiting: ((confirmed: boolean) => void) | undefined;
  let cancels = 0;
  let pausedUntil = 0;
  return {
    confirm: async (review) => {
      if (
        !live ||
        waiting !== undefined ||
        cancels >= cancelsUntilReload ||
        now() < pausedUntil
      ) {
        throw paused();
      }
      const { promise, resolve } = Promise.withResolvers<boolean>();
      waiting = resolve;
      const settle = (confirmed: boolean): void => {
        // Only this question's own dialog ends it.
        if (waiting !== resolve) {
          return;
        }
        waiting = undefined;
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
        show(null);
        ending(false);
      }
    },
  };
};
