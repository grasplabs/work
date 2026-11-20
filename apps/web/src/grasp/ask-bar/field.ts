// The text field inside the panel: the Composer's own textarea. The panel focuses it from outside
// (its handle), so it is found in the panel's own box, never in the whole document. The panel's
// Composer is the host's, so its ref is not the panel's to take; the bar holds its own by ref.

/** The Composer's field inside `box`, or null when there is none (yet). */
export const fieldIn = (box: HTMLElement | null): HTMLElement | null =>
  box?.querySelector<HTMLElement>("textarea, [contenteditable=true]") ?? null;

/** Focuses the field inside `box` without scrolling anything; true when it has focus after. */
export const focusFieldIn = (box: HTMLElement | null): boolean => {
  const field = fieldIn(box);
  if (field === null) {
    return false;
  }
  field.focus({ preventScroll: true });
  return document.activeElement === field;
};
