// What this browser keeps of an admin's setup (routes/setup.tsx), by
// account: how far they went, the message they wrote to their employees
// and what they settled. Their own words, left on a computer others may
// use: forgotten whenever the session ends (core-connection.ts `end`),
// signed out here or found ended, so whoever uses this browser next,
// signed in or not, finds none of it.

/** Where a kept setup's key starts: its account's id follows. */
const keptPrefix = "grasp.setup.";

/** Where this browser keeps the setup of `userId`. */
export const keptKey = (userId: string): string => `${keptPrefix}${userId}`;

/** Forgets every setup this browser keeps, of every account. */
export const forgetKeptSetups = (): void => {
  try {
    const keys = Array.from(
      { length: localStorage.length },
      (_, index) => localStorage.key(index) ?? ""
    ).filter((key) => key.startsWith(keptPrefix));
    for (const key of keys) {
      localStorage.removeItem(key);
    }
  } catch {
    // Storage refused: nothing was kept.
  }
};
