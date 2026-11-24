/** Runs `run` at `at` (ms since 1970), or at once if that has passed; the way to call it off. */
export const later = (at: number, run: () => void): (() => void) => {
  const timer = setTimeout(run, Math.max(0, at - Date.now()));
  return () => {
    clearTimeout(timer);
  };
};
