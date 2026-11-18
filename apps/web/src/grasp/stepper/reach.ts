// Which steps a person may press (stepper.tsx, looks.tsx): a done step, to go back to it; and with
// `reached`, every step up to the furthest one reached, forward as well as back, but never the step
// they are on.
import type { StepperState } from "./stepper";

export const canPress = (
  state: StepperState,
  index: number,
  current: number,
  reached: number | undefined
): boolean => {
  if (state === "done") {
    return true;
  }
  return reached !== undefined && index !== current && index <= reached;
};

/**
 * How a step is drawn and said: a step still to come that the person has reached and come back from
 * was done, so it is drawn and said as done; the line's own fill still follows `current`.
 */
export const shownState = (
  state: StepperState,
  index: number,
  current: number,
  reached: number | undefined
): StepperState =>
  state === "coming" &&
  reached !== undefined &&
  index > current &&
  index <= reached
    ? "done"
    : state;
