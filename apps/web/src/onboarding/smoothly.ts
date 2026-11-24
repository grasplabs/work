// One calm crossfade from a screen of the setup to the next: the
// browser's own view transition (its default fade, well inside 300 ms),
// so nothing slides or flies and the page simply settles into the next
// one. Under reduced motion, or where the browser has no view transitions,
// the screen just changes. A change asked for while one is under way joins
// it, so a step that changes the language and then the screen fades once.

let changing = false;

/** Makes `change` (over once the new screen is there) as one quiet crossfade. */
export const smoothly = async (change: () => Promise<void>): Promise<void> => {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (changing || still || !("startViewTransition" in document)) {
    await change();
    return;
  }
  changing = true;
  try {
    await document.startViewTransition(change).updateCallbackDone;
  } finally {
    changing = false;
  }
};
