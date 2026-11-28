import { describe, expect, it } from "vite-plus/test";

import { afterStart } from "./frame-restart.ts";
import type { PageState } from "./page-host.ts";

// When a preview's frame starts afresh by itself: each step is the
// frame's state and the draft's revision as the page sees them, folded
// as the frame does, from the revision its start began at.

const failed: PageState = { status: "failed", reason: "not-found" };
const running: PageState = { status: "running" };
const loading: PageState = { status: "loading" };

/** Whether each step started the frame afresh, from `startedAt`. */
const restarts = (
  startedAt: number | undefined,
  steps: readonly [PageState, number | undefined][]
): boolean[] => {
  let held = startedAt;
  return steps.map(([state, now]) => {
    const next = afterStart(state, now, held);
    held = next.startedAt;
    return next.afresh;
  });
};

describe("a preview's frame starting afresh by itself", () => {
  it("starts a failed start afresh at once when a write landed while it started, and once only", () => {
    expect(
      restarts(1, [
        [loading, 2],
        [failed, 2],
        [loading, 2],
        [failed, 2],
      ])
    ).toStrictEqual([false, true, false, false]);
  });

  it("waits for a write past the revision a start failed at", () => {
    expect(
      restarts(1, [
        [failed, 1],
        [failed, 2],
      ])
    ).toStrictEqual([false, true]);
  });

  it("holds a frame that began before the draft was read at the revision it failed at", () => {
    expect(
      restarts(undefined, [
        [loading, 3],
        [failed, 3],
        [failed, 4],
      ])
    ).toStrictEqual([false, false, true]);
  });

  it("holds a frame that ran, and failed after taking writes, at the revision it failed at", () => {
    expect(
      restarts(1, [
        [running, 1],
        [running, 5],
        [failed, 5],
        [failed, 6],
      ])
    ).toStrictEqual([false, false, false, true]);
  });

  it("never starts a frame with no revision afresh: an App's own page", () => {
    expect(
      restarts(undefined, [
        [failed, undefined],
        [failed, undefined],
      ])
    ).toStrictEqual([false, false]);
  });
});
