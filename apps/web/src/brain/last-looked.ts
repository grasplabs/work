// When a person last looked at the brain's activity, kept in this
// browser's storage, one entry per person, as the theme is (frame/
// theme.ts): core keeps no such moment, and it only decides what the
// page shows as new, never what anyone may read.

/** How far back a first look goes. */
const firstLookMs = 7 * 24 * 60 * 60 * 1000;

const personKey = (userId: string): string => `grasp-brain-looked:${userId}`;

/**
 * When `userId` last looked in this browser (ISO 8601), or a week ago on
 * their first look, or where storage is blocked.
 */
export const lastLooked = (userId: string, now: Date): string => {
  try {
    const kept = localStorage.getItem(personKey(userId));
    if (kept !== null && !Number.isNaN(Date.parse(kept))) {
      return new Date(kept).toISOString();
    }
  } catch {
    // Storage blocked: every look is a first one.
  }
  return new Date(now.getTime() - firstLookMs).toISOString();
};

/** Keeps `at` as when `userId` last looked, in this browser. */
export const keepLooked = (userId: string, at: Date): void => {
  try {
    localStorage.setItem(personKey(userId), at.toISOString());
  } catch {
    // Storage blocked: the next look starts from a week ago again.
  }
};
