import { claimImprovementSignals, storeImprovementSignals } from "./signals.ts";

// What is computed once a UTC day: the improvement signals (signals.ts).
// The 15-minute clock claims the day (daily-claims.ts); a claim that
// lapses unfinished is taken over by a later run.

/**
 * Computes the improvement signals of `now`'s UTC day, if they are due.
 * Its clock calls it every 15 minutes.
 */
export const refreshDailySignals = async (
  env: Env,
  now = new Date()
): Promise<void> => {
  const computation = await claimImprovementSignals(env, now);
  if (computation !== undefined) {
    await storeImprovementSignals(env, computation);
  }
};
