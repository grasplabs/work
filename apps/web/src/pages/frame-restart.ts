import type { PageState } from "./page-host.ts";

// When the App's preview starts its frame afresh by itself (page-frame.tsx):
// a frame that failed takes no updates, so a newer revision of the draft
// is what may fix it.

/**
 * Where a preview's frame in `state` stands at the draft's revision `now`:
 * whether it starts afresh, and the revision it holds from here
 * (`startedAt`, the one its start began at; none while it runs, or when
 * it began before the draft was read). A start that failed starts afresh
 * once the draft is past the revision it began at, which a write landing
 * while it started already is. A frame that ran, or whose start's
 * revision isn't known, holds the revision it failed at, and starts
 * afresh only past that.
 */
export const afterStart = (
  state: PageState,
  now: number | undefined,
  startedAt: number | undefined
): { startedAt: number | undefined; afresh: boolean } => {
  if (state.status === "running" || state.status === "fixing") {
    return { startedAt: undefined, afresh: false };
  }
  if (state.status !== "failed" || now === undefined) {
    return { startedAt, afresh: false };
  }
  if (startedAt === undefined || now <= startedAt) {
    return { startedAt: startedAt ?? now, afresh: false };
  }
  return { startedAt: now, afresh: true };
};
