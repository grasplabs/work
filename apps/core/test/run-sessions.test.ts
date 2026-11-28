import { functionErrors } from "@grasp-os/shared/functions";
import { describe, expect, it } from "vite-plus/test";

import { inTurn, maxQueuedPerRun } from "../src/run-sessions.ts";

// A run's App calls take their turns one at a time (run-sessions.ts): a
// call that gave up waiting never lets the next one run beside one still
// running, and one whose request was cancelled holds up the run's later
// calls no longer than its own time. A cancelled request never goes on
// (workerd drops the rest of it, its `finally` too), which work that never
// settles stands in for here.

describe("a run's calls in turn", () => {
  it("makes a call made after one that gave up wait for the one still running", async () => {
    const key = `run-${crypto.randomUUID()}`;
    const ran: string[] = [];
    const { promise: aMayEnd, resolve: endA } = Promise.withResolvers<true>();
    // A runs on, past what B waits for.
    const a = inTurn(key, Date.now() + 10_000, async () => {
      ran.push("A started");
      await aMayEnd;
      ran.push("A ended");
    });
    // B gives up waiting while A still runs.
    const b = inTurn(key, Date.now() + 100, async () => {
      ran.push("B");
      await Promise.resolve();
    });
    await expect(b).rejects.toThrow(
      functionErrors.create("function.deadline_exceeded").message
    );
    // C, made after B gave up: it waits for A.
    const c = inTurn(key, Date.now() + 10_000, async () => {
      ran.push("C");
      await Promise.resolve();
    });
    await scheduler.wait(200);
    const beforeA = [...ran];
    endA(true);
    await Promise.all([a, c]);
    expect({ beforeA, ran }).toStrictEqual({
      beforeA: ["A started"],
      ran: ["A started", "A ended", "C"],
    });
  });

  it("serves a run's next call once a call whose request was cancelled is past its time, however many were", async () => {
    const key = `run-${crypto.randomUUID()}`;
    const served: number[] = [];
    const cancelled: Promise<void>[] = [];
    const { promise: testOver, resolve: endTest } =
      Promise.withResolvers<true>();
    // More cancelled calls than the run may queue at once, one by one.
    for (let round = 0; round <= maxQueuedPerRun; round += 1) {
      // Takes its turn, and is cancelled: it doesn't go on while the test runs.
      cancelled.push(
        inTurn(key, Date.now() + 20, async () => {
          await testOver;
        })
      );
      // oxlint-disable-next-line no-await-in-loop -- one round after the other
      const next = await inTurn(key, Date.now() + 10_000, async () => {
        await Promise.resolve();
        return round;
      });
      served.push(next);
    }
    endTest(true);
    await Promise.all(cancelled);

    expect(served).toStrictEqual(
      Array.from({ length: maxQueuedPerRun + 1 }, (_, round) => round)
    );
  });

  it("makes a call made once one ran past its deadline wait for it to end", async () => {
    const key = `run-${crypto.randomUUID()}`;
    const ran: string[] = [];
    const { promise: aMayEnd, resolve: endA } = Promise.withResolvers<true>();
    // A runs on past its own deadline, as one winding down does.
    const a = inTurn(key, Date.now() + 1000, async () => {
      ran.push("A started");
      await aMayEnd;
      ran.push("A ended");
    });
    await scheduler.wait(1100);
    const c = inTurn(key, Date.now() + 10_000, async () => {
      ran.push("C");
      await Promise.resolve();
    });
    await scheduler.wait(300);
    const beforeA = [...ran];
    endA(true);
    await Promise.all([a, c]);
    expect({ beforeA, ran }).toStrictEqual({
      beforeA: ["A started"],
      ran: ["A started", "A ended", "C"],
    });
  });
});
