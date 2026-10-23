// When a confirmation in Grasp's own dialog may count (link-confirmation.tsx):
// pure logic, so tested on its own. A screen can't make the person confirm
// what they didn't mean to:
//
// - A click or key already on its way as the dialog opens, which a screen
//   could time its request for, confirms nothing: the confirm button is
//   enabled only `delayMs` after the dialog opened, and every pointer press
//   or key in that time starts the delay again, so a person clicking or
//   typing fast through the page never lands on it.
// - Only a press that starts once the button is enabled counts: a press
//   begun while it was disabled, released after, confirms nothing.
// - Assistive technology activates the button with a click alone, no
//   press before it: such a click counts as a press of its own at the
//   moment it lands, held to the same delay, so a screen reader can
//   confirm and a press begun too early still can't.

/** One dialog's gate, from when it opened. */
export interface ConfirmGate {
  /** A pointer press or key anywhere at `at`: restarts the delay if it runs. */
  readonly input: (at: number) => void;
  /** When the confirm button is enabled, as things stand. */
  readonly enabledFrom: () => number;
  /** A press of the confirm button itself began at `at`. */
  readonly press: (at: number) => void;
  /**
   * Whether the press that ends in a confirmation counts; `clickedAt` is
   * when a click with no press of its own (assistive technology's) landed.
   */
  readonly accepts: (clickedAt?: number) => boolean;
}

/** The gate of a dialog that opened at `openedAt`, enabled `delayMs` after. */
export const confirmGate = (openedAt: number, delayMs: number): ConfirmGate => {
  let startedAt = openedAt;
  let pressedAt: number | undefined;
  const enabledFrom = (): number => startedAt + delayMs;
  return {
    input: (at) => {
      if (at < enabledFrom()) {
        startedAt = at;
      }
    },
    enabledFrom,
    press: (at) => {
      pressedAt = at;
    },
    accepts: (clickedAt) => {
      const began = pressedAt ?? clickedAt;
      return began !== undefined && began >= enabledFrom();
    },
  };
};
