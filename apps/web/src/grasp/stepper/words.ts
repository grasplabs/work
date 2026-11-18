// Stepper's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `stateLabels`, `countLabel` and `finishedLabel` still win until the
// breaking release's step 5. The steps' names are the caller's.
import type { StepperState } from "./stepper";

export const stepperWords = {
  /** Said after a step, by its state. */
  states: {
    done: "done",
    current: "current step",
    coming: "not started",
    failed: "failed",
  } satisfies Record<StepperState, string>,
  /** Which step of how many ("Step 2 of 4"). */
  count: (step: number, total: number) => `Step ${step} of ${total}`,
  /** Said once every step is done. */
  finished: "All steps done",
};

export type StepperWords = typeof stepperWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    stepper: StepperWords;
  }
}
