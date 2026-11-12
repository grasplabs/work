import { useEffect, useEffectEvent, useRef } from "react";
import type { RefObject } from "react";

/**
 * Calls `onOpenChangeComplete` once `ref`'s element has finished its CSS
 * transitions after `open` changed, as Base UI's components do: what moves
 * next can wait for it rather than for a guessed number of milliseconds.
 * Where nothing transitions (reduced motion, a hidden element, a test
 * without a browser), it calls at once. Only the element's own transitions
 * count, never an animation inside it, such as a spinner, that never ends.
 */
export const useOpenChangeComplete = (
  ref: RefObject<Element | null>,
  open: boolean,
  onOpenChangeComplete: ((open: boolean) => void) | undefined
): void => {
  const complete = useEffectEvent((isOpen: boolean) => {
    onOpenChangeComplete?.(isOpen);
  });
  const last = useRef(open);
  useEffect(() => {
    if (last.current === open) {
      return;
    }
    last.current = open;
    // Asking for them also brings styles up to date, so a transition that
    // this render started is among them.
    const transitions = (ref.current?.getAnimations?.() ?? []).filter(
      (animation) => "transitionProperty" in animation
    );
    const settle = async () => {
      // A transition cut short (the element hidden, say) ends it too.
      await Promise.allSettled(
        transitions.map(async (transition) => await transition.finished)
      );
      // Said for what it still is to be: a later change says its own. Not
      // tied to this effect's run, which React may clean up and run again
      // with nothing changed (a tree shown again), and which would then
      // never say it at all.
      if (last.current === open) {
        complete(open);
      }
    };
    void settle();
  }, [ref, open]);
};
