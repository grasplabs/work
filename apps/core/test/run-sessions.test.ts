import { operationErrors } from "@grasp-os/shared/operations";
import { describe, expect, it } from "vite-plus/test";

import { inTurn } from "../src/run-sessions.ts";

// A run's App calls take their turns one at a time (run-sessions.ts): a
// call that gave up waiting never lets the next one run beside one still
// running.

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
      operationErrors.create("operation.deadline_exceeded").message
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
});
