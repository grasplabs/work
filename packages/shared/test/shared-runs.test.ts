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
    runs.set("build", {
      promise: abandoned.promise,
      started: Date.now(),
      abandonAfterMs,
    });
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
    runs.set("build", {
      promise: abandoned.promise,
      started: Date.now(),
      abandonAfterMs,
    });
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
    runs.set("build", {
      promise: running.promise,
      started: Date.now(),
      abandonAfterMs,
    });
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

  it("starts no replacement for a waiter given up on while it waited, and leaves it to another", async () => {
    const runs = new Map<string, SharedRun<string>>();
    const abandoned = held<string>();
    runs.set("build", {
      promise: abandoned.promise,
      started: Date.now(),
      abandonAfterMs,
    });
    let starts = 0;
    const start = async (): Promise<string> => {
      starts += 1;
      return await Promise.resolve("rebuilt");
    };
    const giveUp = new AbortController();
    const givenUp = sharedRun(
      runs,
      "build",
      abandonAfterMs,
      start,
      giveUp.signal
    );
    // Its lease lost while it waits on the abandoned build.
    await sleep(abandonAfterMs / 2);
    giveUp.abort(new Error("lost its lease"));
    let first: string;
    try {
      first = await givenUp;
    } catch (error) {
      first = error instanceof Error ? error.message : String(error);
    }
    const startsThen = starts;
    // Another waiter still replaces the abandoned build, and shares it.
    const other = await sharedRun(runs, "build", abandonAfterMs, start);
    expect({ first, startsThen, other, starts }).toStrictEqual({
      first: "lost its lease",
      startsThen: 0,
      other: "rebuilt",
      starts: 1,
    });
  });

  it("drops abandoned work nobody asks for or waits on at the next call for any key, and keeps work still running", async () => {
    const runs = new Map<string, SharedRun<string>>();
    const now = Date.now();
    // Abandoned, and no longer waited on: started twice its own time ago.
    runs.set("gone", {
      promise: held<string>().promise,
      started: now - 2 * abandonAfterMs - 1,
      abandonAfterMs,
    });
    // Abandoned, but a waiter may still be about to follow its link.
    runs.set("just abandoned", {
      promise: held<string>().promise,
      started: now - abandonAfterMs - 1,
      abandonAfterMs,
    });
    // Within its own time, however short the caller's.
    const running = held<string>();
    runs.set("running", {
      promise: running.promise,
      started: now - 2 * abandonAfterMs - 1,
      abandonAfterMs: 60_000,
    });

    const answer = await sharedRun(runs, "other", 1, async () => {
      await Promise.resolve();
      return "own";
    });

    expect({ answer, left: [...runs.keys()] }).toStrictEqual({
      answer: "own",
      left: ["just abandoned", "running"],
    });
    running.resolve("done");
  });
});
