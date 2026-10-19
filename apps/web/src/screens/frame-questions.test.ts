import type { DecisionView } from "@grasp-os/shared/decisions";
import { decisionErrors } from "@grasp-os/shared/decisions";
import { describe, expect, it } from "vite-plus/test";

import type { PendingConfirmation } from "../decision-confirmation.tsx";
import { cancelPauseMs, frameQuestions } from "./frame-questions.ts";
import type { Asked } from "./frame-questions.ts";

// The answers one frame's screen asks the person to confirm, from the ways
// a screen could abuse the dialog: stacking questions, asking again as
// soon as the person cancels so they're stuck behind it, and a dialog's
// answer landing on another question that took its place.

/** A question as core gives it for review, told apart by `id`. */
const review = (id: string): PendingConfirmation => ({
  // SAFETY: only its identity matters here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  decision: { id } as DecisionView,
  response: { approved: true },
});

/** What a question came to: confirmed or not, or the refusal's code. */
const outcome = async (asking: Promise<boolean>): Promise<unknown> => {
  try {
    return await asking;
  } catch (error) {
    return decisionErrors.codeOf(error);
  }
};

/** Questions with a clock the test moves, and what the dialog shows. */
const questions = () => {
  let clock = 0;
  let shown: Asked | null = null;
  const asked = frameQuestions(
    (next) => {
      shown = next;
    },
    () => clock
  );
  return {
    ...asked,
    shown: (): Asked => {
      if (shown === null) {
        throw new Error("Nothing is shown");
      }
      return shown;
    },
    hidden: (): boolean => shown === null,
    wait: (ms: number) => {
      clock += ms;
    },
  };
};

describe("a frame's questions", () => {
  it("asks one at a time, and refuses one asked while another waits", async () => {
    const frame = questions();
    const first = frame.confirm(review("a"));
    const second = await outcome(frame.confirm(review("b")));
    frame.shown().settle(true);

    expect({ first: await first, second }).toStrictEqual({
      first: true,
      second: "decision.asking_paused",
    });
  });

  it("refuses questions for a while after a cancel, and until reload after two", async () => {
    const frame = questions();
    const first = frame.confirm(review("a"));
    frame.shown().settle(false);
    const cancelled = await first;
    const rightAway = await outcome(frame.confirm(review("a")));
    frame.wait(cancelPauseMs);
    const later = frame.confirm(review("a"));
    frame.shown().settle(false);
    const cancelledAgain = await later;
    frame.wait(60 * cancelPauseMs);
    const afterTwo = await outcome(frame.confirm(review("a")));

    expect({ cancelled, rightAway, cancelledAgain, afterTwo }).toStrictEqual({
      cancelled: false,
      rightAway: "decision.asking_paused",
      cancelledAgain: false,
      afterTwo: "decision.asking_paused",
    });
  });

  it("settles a question only from its own dialog", async () => {
    const frame = questions();
    const first = frame.confirm(review("a"));
    const { settle: settleFirst } = frame.shown();
    settleFirst(true);
    await first;
    const second = frame.confirm(review("b"));
    // The first dialog's answer, arriving late, confirms nothing else.
    settleFirst(true);
    settleFirst(false);
    const stillShown = frame.shown().review.decision.id;
    frame.shown().settle(true);

    expect({ stillShown, second: await second }).toStrictEqual({
      stillShown: "b",
      second: true,
    });
  });

  it("ends its question unconfirmed when the frame stops, and asks nothing after", async () => {
    const frame = questions();
    const waiting = frame.confirm(review("a"));
    frame.end();

    expect({
      waiting: await waiting,
      hidden: frame.hidden(),
      after: await outcome(frame.confirm(review("b"))),
    }).toStrictEqual({
      waiting: false,
      hidden: true,
      after: "decision.asking_paused",
    });
  });
});
