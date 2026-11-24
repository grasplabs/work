// The handover both uploads make as the page wakes: until its script runs, the browser's own file
// input does the work; then the live control is drawn in its place. A person who had already
// reached that input by keyboard keeps their place: focus goes on to the live control, not to the
// page.
"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/**
 * Whether the page runs its script: false as the server draws it, true from then on. `native` is
 * the browser's own input, drawn only until then; `takeFocus` gives focus to the control that
 * takes its place, and runs when the input had it.
 */
export const useHandover = (
  native: RefObject<HTMLInputElement | null>,
  takeFocus: () => void
): boolean => {
  const [mounted, setMounted] = useState(false);
  const held = useRef(false);

  useEffect(() => {
    held.current =
      native.current !== null && native.current === document.activeElement;
    // oxlint-disable-next-line react/set-state-in-effect -- the browser's own input hands over only once the page runs its script
    setMounted(true);
  }, [native]);

  // As the input leaves, before the browser takes a key: none falls on the page in between.
  useLayoutEffect(() => {
    if (mounted && held.current) {
      held.current = false;
      takeFocus();
    }
  }, [mounted, takeFocus]);

  return mounted;
};
