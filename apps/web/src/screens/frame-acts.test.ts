import { describe, expect, it } from "vite-plus/test";

import { actLifetimeMs, frameActs } from "./frame-acts.ts";

// What counts as the person acting in a screen's frame: only what its
// bootstrap reports on the port it alone holds, once, while it could still
// be the browser's activation. The screen's code can post anywhere else.

/** Lets the ports deliver what was posted. */
const delivered = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<null>();
  setTimeout(() => {
    resolve(null);
  }, 20);
  await promise;
};

/** A frame's acts port and the page's side of it, on a clock to move. */
const framed = () => {
  const clock = { now: 0 };
  const { port1, port2 } = new MessageChannel();
  const acts = frameActs(port1, () => clock.now);
  return { clock, acts, bootstrap: port2 };
};

describe("a person's acts in a screen's frame", () => {
  it("count once each: one act, one navigation", async () => {
    const { acts, bootstrap } = framed();
    const before = acts.take();
    bootstrap.postMessage(null, []);
    await delivered();
    const acted = acts.take();
    const again = acts.take();
    acts.close();
    expect({ before, acted, again }).toStrictEqual({
      before: false,
      acted: true,
      again: false,
    });
  });

  it("count the latest act only, never one per message sent in a burst", async () => {
    const { acts, bootstrap } = framed();
    for (const _ of [1, 2, 3]) {
      bootstrap.postMessage(null, []);
    }
    await delivered();
    const first = acts.take();
    const second = acts.take();
    acts.close();
    expect({ first, second }).toStrictEqual({ first: true, second: false });
  });

  it("count no act older than the browser's activation can last", async () => {
    const { clock, acts, bootstrap } = framed();
    bootstrap.postMessage(null, []);
    await delivered();
    clock.now = actLifetimeMs;
    const late = acts.take();
    bootstrap.postMessage(null, []);
    await delivered();
    clock.now += actLifetimeMs - 1;
    const inTime = acts.take();
    acts.close();
    expect({ late, inTime }).toStrictEqual({ late: false, inTime: true });
  });

  it("count nothing the screen's code posts on the ports it holds, act-shaped or not", async () => {
    const { acts } = framed();
    // The screen's bridge port, as its code reaches it.
    const bridge = new MessageChannel();
    bridge.port1.start();
    bridge.port2.postMessage(null, []);
    await delivered();
    const taken = acts.take();
    acts.close();
    bridge.port1.close();
    expect(taken).toBeFalsy();
  });
});
