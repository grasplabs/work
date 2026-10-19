import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Session } from "../core.ts";
import { CoreLink, retryingOn } from "./core-link.ts";

// A frame's call on its connection (core-link.ts `retryingOn`): what
// stops while the session is on its way, such as a frame that left the
// tab's connection, sends nothing once the session is there.

describe("a frame's call on its connection", () => {
  it("sends nothing once the frame left while its session was on its way", async () => {
    let open = true;
    const sent: string[] = [];
    // SAFETY: the session is only handed on, never used here.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const session = {} as Session;
    const call = retryingOn(
      async () => {
        await Promise.resolve();
        // The frame leaves in the moment the session arrives.
        open = false;
        return session;
      },
      async () => {
        sent.push("open");
        return await Promise.resolve("opened");
      },
      () => open
    );

    await expect(call).rejects.toThrow(Error);
    expect(sent).toStrictEqual([]);
  });
});

// A frame's link to core across a dropped connection: it connects again,
// on whatever session the browser's cookie now holds. Core stands in here
// as connections that answer who is signed in, each for the person the
// test names, and break when told.

/** Connections to core, each signed in as the next of `people`. */
const connections = (people: readonly string[]) => {
  const breaks: (() => void)[] = [];
  let opened = 0;
  const open = () => {
    const userId = people[Math.min(opened, people.length - 1)] ?? "";
    opened += 1;
    const session = {
      whoami: async () => await Promise.resolve({ userId }),
    };
    const core = {
      authenticate: () => session,
      onRpcBroken: (onBroken: () => void) => {
        breaks.push(onBroken);
      },
      [Symbol.dispose]: () => {
        // Nothing to let go of.
      },
    };
    // SAFETY: the link reaches only `authenticate`, `whoami`,
    // `onRpcBroken` and disposal, which this stand-in has.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- see SAFETY
    return core as unknown as ReturnType<
      NonNullable<ConstructorParameters<typeof CoreLink>[1]>
    >;
  };
  return { open, breaks };
};

/** The code `promise` rejected with, or that it resolved. */
const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : error;
  }
};

describe("a frame's link to core after its connection drops", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends, as someone else's, when it connects again as someone else", async () => {
    vi.useFakeTimers();
    const core = connections(["ada", "bob"]);
    const ended: string[] = [];
    const link = new CoreLink((why) => {
      ended.push(why);
    }, core.open);
    await link.session();
    core.breaks[0]?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect({
      ended,
      session: await codeOf(link.session()),
    }).toStrictEqual({
      ended: ["principal-changed"],
      session: "auth.principal_changed",
    });
  });

  it("goes on when it connects again as the same person", async () => {
    vi.useFakeTimers();
    const core = connections(["ada", "ada"]);
    let ended = 0;
    const link = new CoreLink(() => {
      ended += 1;
    }, core.open);
    await link.session();
    core.breaks[0]?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ended).toBe(0);
    await expect(codeOf(link.session())).resolves.toBe("resolved");
  });
});
