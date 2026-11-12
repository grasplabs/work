// The one-time tip in a newly made App's workspace (app-workspace.tsx):
// "Open" under a chat's finished build (chat/build-progress.tsx) marks
// the App it made as it takes the person there, and the tip shows until they dismiss it, which this
// browser remembers. Kept in the browser alone: a tip is a convenience,
// and storage that is blocked or cleared only means no tip.

const keyOf = (app: string): string => `grasp:made-tip:${app}`;

/** Marks `app` as just made here: its workspace shows the tip. */
export const markMade = (app: string): void => {
  try {
    localStorage.setItem(keyOf(app), "1");
  } catch {
    // No storage: no tip.
  }
};

/** Whether `app`'s workspace shows the tip: made here, and not dismissed. */
export const showsMadeTip = (app: string): boolean => {
  try {
    return localStorage.getItem(keyOf(app)) === "1";
  } catch {
    return false;
  }
};

/** Dismisses the tip of `app` for good, in this browser. */
export const dismissMadeTip = (app: string): void => {
  try {
    localStorage.removeItem(keyOf(app));
  } catch {
    // No storage: nothing was kept.
  }
};
