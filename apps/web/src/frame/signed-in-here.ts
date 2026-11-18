// Whether someone was signed in on this browser when Grasp last asked: the
// one thing the frame keeps across a reload, so a reload paints the frame at
// once (frame/shell-pending.tsx) while core says who is in. It says nothing
// of who: no name, role, chat or App is kept, so a browser left signed out,
// or someone else's, shows nothing of the last person before core answers.
// Kept in localStorage, not a cookie: the session cookie is httpOnly, and
// this travels to no server.

const key = "grasp.signed-in";

/** Notes that core said someone is signed in here. */
export const markSignedIn = (): void => {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Storage blocked: a reload starts blank, as it would without this.
  }
};

/** Forgets it: signed out, the session ended, or core said nobody is in. */
export const forgetSignedIn = (): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage blocked: nothing was kept.
  }
};

/** Whether someone was signed in here when core last said. */
export const wasSignedIn = (): boolean => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};
