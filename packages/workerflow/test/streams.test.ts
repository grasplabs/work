// The race of an upload's reads against its end (streams.ts): pure logic,
// tested on its own. The window it guards (the end coming while a chunk is
// hashed, then the source erroring) can't be reached on cue through a run.
import { describe, expect, test } from "vite-plus/test";

import { stopOf } from "../src/streams.ts";

/** A turn of the event loop: unhandled rejections are reported after one. */
const nextTurn = async (): Promise<void> => {
  await scheduler.wait(0);
};

describe("an upload's reads raced against its end", () => {
  test("starts no read once the end has come, so a source that errors then leaves nothing unhandled", async () => {
    const unhandled: unknown[] = [];
    const listen = (event: PromiseRejectionEvent): void => {
      unhandled.push(event.reason);
    };
    addEventListener("unhandledrejection", listen);
    try {
      const end = Promise.withResolvers<true>();
      const stop = stopOf(end.promise);
      end.resolve(true);
      await nextTurn();
      let started = 0;

      const outcome = await stop.race(async () => {
        started += 1;
        await Promise.resolve();
        throw new Error("the source broke after the end");
      });
      await nextTurn();

      expect({ started, unhandled }).toStrictEqual({
        started: 0,
        unhandled: [],
      });
      expect(outcome).toBeTypeOf("symbol");
    } finally {
      removeEventListener("unhandledrejection", listen);
    }
  });

  test("handles the rejection of a read the end beat", async () => {
    const unhandled: unknown[] = [];
    const listen = (event: PromiseRejectionEvent): void => {
      unhandled.push(event.reason);
    };
    addEventListener("unhandledrejection", listen);
    try {
      const end = Promise.withResolvers<true>();
      const read = Promise.withResolvers<never>();
      const stop = stopOf(end.promise);

      const racing = stop.race(async () => await read.promise);
      end.resolve(true);
      const outcome = await racing;
      read.reject(new Error("the source broke after the end"));
      await nextTurn();

      expect(outcome).toBeTypeOf("symbol");
      expect(unhandled).toStrictEqual([]);
    } finally {
      removeEventListener("unhandledrejection", listen);
    }
  });

  test("gives a read that comes first its value", async () => {
    const stop = stopOf(Promise.withResolvers<never>().promise);

    await expect(
      stop.race(async () => await Promise.resolve({ done: true }))
    ).resolves.toStrictEqual({ done: true });
  });
});
