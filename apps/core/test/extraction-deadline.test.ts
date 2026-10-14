import { describe, expect, it } from "vite-plus/test";

import { busyPlan } from "../src/knowledge/extraction.ts";

// How long an upload waits for a place in the sandbox (extraction.ts): an
// hour from its first busy try, which no wait or try runs past. Pure
// arithmetic, tested on its own: the workflow's clock can't be driven in
// a test yet, so an hour-long wait can't be run through.

const minute = 60_000;
const hour = 60 * minute;

describe("an upload's wait for a place in the sandbox", () => {
  it("waits as long as asked, and gives a try its full time, early in the hour", () => {
    expect(busyPlan(0, 0, 30_000)).toStrictEqual({
      over: false,
      sleepMs: 30_000,
      attemptMs: 10 * minute,
      deadline: hour,
    });
  });

  it("cuts the last wait short so a try still fits, and that try ends by the hour", () => {
    const since = 1_000_000;
    const at = since + hour - 2 * minute;

    expect(busyPlan(since, at, 5 * minute)).toStrictEqual({
      over: false,
      sleepMs: minute,
      attemptMs: minute,
      deadline: since + hour,
    });
  });

  it("is over once the hour leaves no room for a try, or has passed", () => {
    expect([
      busyPlan(0, hour - 30_000, 5 * minute),
      busyPlan(0, hour, 0),
      busyPlan(0, hour + minute, 0),
    ]).toStrictEqual([{ over: true }, { over: true }, { over: true }]);
  });

  it("never plans a wait and a try that run past the hour", () => {
    const late: number[] = [];
    for (let at = 0; at <= hour; at += 7919) {
      const plan = busyPlan(0, at, 5 * minute);
      if (!plan.over && at + plan.sleepMs + plan.attemptMs > plan.deadline) {
        late.push(at);
      }
    }

    expect(late).toStrictEqual([]);
  });
});
