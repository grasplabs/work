// How a theme changes on screen. A person's own pick through the Theme switch is revealed by a
// circle growing from the switch they pressed (`reveal`, theme-reveal, 300ms, on our ease); a
// product may choose a crossfade of the page (`crossfade`, theme-fade, 280ms) or one frame
// (`instant`). Everything else (a page loading, the system turning dark, a subtree) changes in one
// frame. With reduced motion, or where a browser has no View Transitions, every way is one frame.
// The animation's rules live in themes.css; this only starts it.

/** How a person's own change of theme is drawn. */
export type ThemeChange = "reveal" | "crossfade" | "instant";

/** Where the change starts from: the centre of the control pressed, in the window. */
export interface ThemeChangeOrigin {
  x: number;
  y: number;
}

const clearChange = async (finished: Promise<unknown>) => {
  try {
    await finished;
  } catch {
    // A transition skipped or cut short still changed the theme: only the mark is left to clear.
  }
  delete document.documentElement.dataset.graspChange;
};

/**
 * Runs `apply` (which must change the DOM before it returns) the chosen way. A View Transition
 * captures the page before and after, and themes.css animates between them.
 */
export const changeTheme = (
  way: ThemeChange,
  apply: () => void,
  origin?: ThemeChangeOrigin
): void => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (way === "instant" || reduced || !("startViewTransition" in document)) {
    apply();
    return;
  }
  const root = document.documentElement;
  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? 0;
  // The circle reaches the window's farthest corner from where it starts.
  const reach = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y)
  );
  root.style.setProperty("--grasp-change-x", `${x}px`);
  root.style.setProperty("--grasp-change-y", `${y}px`);
  root.style.setProperty("--grasp-change-r", `${reach}px`);
  root.dataset.graspChange = way;
  const transition = document.startViewTransition(apply);
  void clearChange(transition.finished);
};
