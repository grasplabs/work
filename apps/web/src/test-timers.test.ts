import * as timers from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vite-plus/test";

import { trackTimers } from "./test-timers.ts";

// The set-up (test-setup.ts) runs `trackTimers(globalThis)` and its
// cancelling in an `afterAll` after the file's own hooks, so here it works
// on timers of its own, with Node's timers underneath.
const tracked = () => {
  const on = {
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  };
  return { on, close: trackTimers(on) };
};

describe("a file's timers", () => {
  it("runs a timer that ends before the file does", async () => {
    const { on } = tracked();
    const run = vi.fn<(word?: string) => void>();
    on.setTimeout(run, 1, "said");
    await sleep(20);
    expect(run).toHaveBeenCalledWith("said");
  });

  it("never runs a timer still waiting when the file ends", async () => {
    const { on, close } = tracked();
    const run = vi.fn<(word?: string) => void>();
    on.setTimeout(run, 10);
    close();
    await sleep(30);
    expect(run).not.toHaveBeenCalled();
  });

  it("never runs a timer started after the file ended", async () => {
    const { on, close } = tracked();
    const run = vi.fn<(word?: string) => void>();
    close();
    on.setTimeout(run, 0);
    await sleep(20);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the set-up's timers", () => {
  it("keep util.promisify(setTimeout) working", async () => {
    // oxlint-disable-next-line typescript/strict-void-return -- Node's promisify hook on setTimeout is what this checks
    await expect(promisify(setTimeout)(1, "said")).resolves.toBe("said");
  });

  it("are back after a test's fake timers", () => {
    const own = { setTimeout, clearTimeout };
    expect(own.setTimeout).not.toBe(timers.setTimeout);
    expect(own.clearTimeout).not.toBe(timers.clearTimeout);
    vi.useFakeTimers();
    expect(setTimeout).not.toBe(own.setTimeout);
    vi.useRealTimers();
    expect(setTimeout).toBe(own.setTimeout);
    expect(clearTimeout).toBe(own.clearTimeout);
  });
});
