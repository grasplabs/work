import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vite-plus/test";

import { sharedRun } from "../src/shared-runs.ts";
import type { SharedRun } from "../src/shared-runs.ts";

// Work shared across the requests of an isolate (src/shared-runs.ts):
// pure scheduling, so tested on its own. Work whose request was cancelled
// never settles (workerd drops it), which a promise that never settles
// stands in for here.

/** How long the work here may take before it is taken for abandoned. */
const abandonAfterMs = 50;

/** A promise that settles only when told, as a cancelled request's never does. */
const held = <T>() => Promise.withResolvers<T>();

describe("work shared across requests", () => {
  it("starts one replacement for an abandoned run, however many wait on it", async () => {
    const runs = new Map<string, SharedRun<string>>();
    const abandoned = held<string>();
    runs.set("build", { promise: abandoned.promise, started: Date.now() });
    let starts = 0;
    const start = async (): Promise<string> => {
      starts += 1;
      await sleep(10);
      return "rebuilt";
    };

    const answers = await Promise.all(
      Array.from(
        { length: 10 },
        async () => await sharedRun(runs, "build", abandonAfterMs, start)
      )
    );

    expect({
      starts,
      answers: new Set(answers),
      left: runs.size,
    }).toStrictEqual({ starts: 1, answers: new Set(["rebuilt"]), left: 0 });
  });

  it("starts one replacement however quickly it finishes, though each waiter's time runs out on its own", async () => {
    const runs = new Map<string, SharedRun<string>>();
    const abandoned = held<string>();
    runs.set("build", { promise: abandoned.promise, started: Date.now() });
    let starts = 0;
    // Each waiter asks a moment after the one before, so their times run
    // out one after the other, after the first one's replacement finished.
    const answers = await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        await sleep(index * 5);
        return await sharedRun(runs, "build", abandonAfterMs, async () => {
          starts += 1;
          return await Promise.resolve("rebuilt");
        });
      })
    );

    expect({
      starts,
      answers: new Set(answers),
      left: runs.size,
    }).toStrictEqual({ starts: 1, answers: new Set(["rebuilt"]), left: 0 });
  });

  it("shares a run that settles in time, and hands its failure to every waiter", async () => {
    const runs = new Map<string, SharedRun<string>>();
    const running = held<string>();
    runs.set("build", { promise: running.promise, started: Date.now() });
    let starts = 0;
    const waiting = Array.from(
      { length: 3 },
      async () =>
        await sharedRun(runs, "build", abandonAfterMs, async () => {
          starts += 1;
          await Promise.resolve();
          return "own";
        }).catch((error: unknown) =>
          error instanceof Error ? error.message : "?"
        )
    );
    running.reject(new Error("The build failed."));

    await expect(Promise.all(waiting)).resolves.toStrictEqual([
      "The build failed.",
      "The build failed.",
      "The build failed.",
    ]);
    expect(starts).toBe(0);
  });
});
