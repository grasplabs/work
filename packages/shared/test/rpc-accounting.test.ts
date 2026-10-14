import { describe, expect, it } from "vite-plus/test";

import { heldPool, messageAccountant } from "../src/rpc-accounting.ts";
import type { RpcAccountingLimits } from "../src/rpc-accounting.ts";

// The accounting is pure logic: given the messages a peer sends (and the
// answers we send back), it says which would make Cap'n Web copy more than a
// session may. These drive it message by message, as the transport does,
// without a socket. The end-to-end bound through a real socket and port is
// in core and the web bridge.

const limits: RpcAccountingLimits = {
  maxMessageBytes: 1024 * 1024,
  maxSessionBytes: 600_000,
  maxMessageNodes: 1000,
  maxMessageCopyNodes: 64,
  maxSessionCopyNodes: 256,
  maxLiveExports: 8,
  answerNodes: 16,
};

/** A fresh accountant, and the ids its pushes take (1, 2, 3, ...). */
const fresh = () => messageAccountant(limits);

/** A value `levels` deep where each level holds two copies of the one below. */
const doubling = (levels: number): unknown[][] => {
  const chain: unknown[][] = [["push", "x"]];
  for (let level = 1; level <= levels; level += 1) {
    chain.push([
      "push",
      [
        [
          ["pipeline", level],
          ["pipeline", level],
        ],
      ],
    ]);
  }
  return chain;
};

describe("the memory a session spends expanding references", () => {
  it("refuses the doubling reference bomb within a few messages", () => {
    const { account } = fresh();
    const refusals = doubling(20).map((message) => account(message));
    const firstRefused = refusals.findIndex((r) => r !== undefined);

    expect(firstRefused).toBeGreaterThan(0);
    expect(firstRefused).toBeLessThan(12);
    expect(refusals[firstRefused]).toBe("copy");
  });

  it("lets honest inline values and followed call results through", () => {
    const { account } = fresh();
    const outcomes = [
      // A ping call.
      account(["push", ["pipeline", 0, ["ping"], []]]),
      // A flat value sent inline (no references), within the node budget.
      account(["push", [[Array.from({ length: 200 }, (_v, i) => i)]]]),
      // Follow a call result once, as `foo(bar())` does.
      account(["push", ["pipeline", 0, ["bar"], []]]),
      account(["push", ["pipeline", 0, ["foo"], [["pipeline", 2]]]]),
    ];

    expect(outcomes).toStrictEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("releasing an export", () => {
  it("frees it only when the refcount reaches zero, as Cap'n Web does", () => {
    const { account } = fresh();
    // A costly export: a push referring to a seed twice.
    // Export 1.
    account(["push", "x"]);
    account([
      "push",
      [
        [
          ["pipeline", 1],
          ["pipeline", 1],
        ],
      ],
    ]);

    // Release 0, negative, and fractional are shapes Cap'n Web wouldn't
    // accept: each ends the session, and the export is never treated as freed.
    expect(fresh().account).toBeDefined();
    const zero = messageAccountant(limits);
    zero.account(["push", "x"]);
    expect(zero.account(["release", 1, 0])).toBe("release");

    const negative = messageAccountant(limits);
    negative.account(["push", "x"]);
    expect(negative.account(["release", 1, -1])).toBe("release");

    const fractional = messageAccountant(limits);
    fractional.account(["push", "x"]);
    expect(fractional.account(["release", 1, 0.5])).toBe("release");

    const tooMany = messageAccountant(limits);
    tooMany.account(["push", "x"]);
    expect(tooMany.account(["release", 1, 2])).toBe("release");
  });

  it("fails closed when a later message refers to a freed export", () => {
    const { account } = fresh();
    // Export 1.
    account(["push", "x"]);
    expect(account(["release", 1, 1])).toBeUndefined();
    // Export 1 is gone; a reference to it would cost nothing while Cap'n Web
    // would error, so it is priced at the session's whole budget and refused.
    expect(account(["push", [[["pipeline", 1]]]])).toBe("copy");
  });

  it("frees the session's budget so honest traffic keeps flowing", () => {
    const { account } = fresh();
    // Make a costly export round after round, releasing each (seed and the
    // value built from it), so neither the session budget nor the live-export
    // count fills: a long honest session keeps flowing.
    for (let round = 0; round < 50; round += 1) {
      const seed = round * 2 + 1;
      expect(account(["push", "x"])).toBeUndefined();
      const made = account([
        "push",
        [
          [
            ["pipeline", seed],
            ["pipeline", seed],
          ],
        ],
      ]);
      expect(made).toBeUndefined();
      expect(account(["release", seed + 1, 1])).toBeUndefined();
      expect(account(["release", seed, 1])).toBeUndefined();
    }
  });
});

describe("a peer that supplies or is sent a large answer", () => {
  it("prices later references to a sent answer at its real size", () => {
    const { account, recordSent } = fresh();
    // The peer calls a method; the call result is export 1.
    expect(account(["push", ["pipeline", 0, ["big"], []]])).toBeUndefined();
    // We answer with a large value (more nodes than one message may copy).
    const answer = Array.from({ length: 500 }, (_v, i) => i);
    recordSent(["resolve", 1, [answer]]);
    // A later reference to export 1 now copies the real answer, and is
    // refused, instead of the small `answerNodes` it was first priced at.
    expect(account(["push", [[["pipeline", 1]]]])).toBe("copy");
  });

  it("prices an export the peer can answer at the whole budget", () => {
    const { account } = fresh();
    // A pushed value holding a promise the peer gave us: the peer may settle
    // export 1 with an answer of any size, so a reference to it is refused.
    expect(account(["push", ["promise", 100]])).toBeUndefined();
    expect(
      account([
        "push",
        [
          [
            ["pipeline", 1],
            ["pipeline", 1],
          ],
        ],
      ])
    ).toBe("copy");
  });

  it("prices a call made through the peer's own stub at the whole budget", () => {
    const { account } = fresh();
    // Export 1 holds a stub the peer gave us; export 2 is a call through it,
    // which the peer answers with whatever it likes. Copying that answer
    // (a plain reference, or a call put in place inside a value) is refused.
    expect(account(["push", ["export", 100]])).toBeUndefined();
    expect(account(["push", ["pipeline", 1, ["get"], []]])).toBeUndefined();
    expect(account(["push", [[["pipeline", 2]]]])).toBe("copy");

    const nested = fresh();
    expect(nested.account(["push", ["export", 100]])).toBeUndefined();
    expect(nested.account(["push", [[["pipeline", 1, ["get"], []]]]])).toBe(
      "copy"
    );
  });

  it("lets a page pass its own callback and use the subscription it gets back", () => {
    const { account } = fresh();
    // `watch(callback)`: the callback is the page's own stub, the answer is
    // ours. The page pulls the subscription, calls through it, passes it on
    // as an argument, and releases it, as the web app and screens do.
    const outcomes = [
      ["push", ["pipeline", 0, ["watch"], [["export", -1]]]],
      ["pull", 1],
      ["push", ["pipeline", 1, ["release"], []]],
      ["pull", 2],
      ["push", ["pipeline", 0, ["unwatch"], [["pipeline", 1]]]],
      ["release", 2, 1],
      ["release", 1, 1],
    ].map((message) => account(message));
    expect(outcomes.every((outcome) => outcome === undefined)).toBeTruthy();
  });

  it("doesn't resurrect a released export when its answer is sent late", () => {
    const { account, recordSent } = fresh();
    expect(account(["push", ["pipeline", 0, ["big"], []]])).toBeUndefined();
    expect(account(["release", 1, 1])).toBeUndefined();
    // A resolve for the now-freed id must not record it alive again.
    recordSent(["resolve", 1, [Array.from({ length: 500 }, (_v, i) => i)]]);
    // A reference to the freed id fails closed, not priced from a stale entry.
    expect(account(["push", [[["pipeline", 1]]]])).toBe("copy");
  });
});

describe("what the peer's live exports hold", () => {
  it("ends the session when unreleased pushes hold more than its bytes", () => {
    const { account } = fresh();
    // Each push holds a string a quarter of the session's bytes: the fifth
    // is past them, however few exports that is.
    const quarter = "a".repeat(limits.maxSessionBytes / 4);
    const outcomes = [1, 2, 3, 4, 5].map(() => account(["push", quarter]));
    expect(outcomes).toStrictEqual([
      undefined,
      undefined,
      undefined,
      "bytes",
      "bytes",
    ]);
  });

  it("frees what a push holds when it is released", () => {
    const { account } = fresh();
    const third = "a".repeat(limits.maxSessionBytes / 3);
    const outcomes: (string | undefined)[] = [];
    // Many more pushes than fit at once, each released before the next.
    for (let id = 1; id <= 20; id += 1) {
      outcomes.push(account(["push", third]), account(["release", id, 1]));
    }
    expect(outcomes.every((outcome) => outcome === undefined)).toBeTruthy();
  });

  it("charges a call's arguments until it is answered, then the answer", () => {
    const { account, recordSent } = fresh();
    const half = "a".repeat(limits.maxSessionBytes / 2);
    expect(
      account(["push", ["pipeline", 0, ["save"], [half]]])
    ).toBeUndefined();
    // Answered small: the arguments are let go, so another large call fits.
    recordSent(["resolve", 1, "saved"]);
    expect(
      account(["push", ["pipeline", 0, ["save"], [half]]])
    ).toBeUndefined();
    // Answered with a large value that the peer never releases: the session
    // ends at its next message.
    recordSent(["resolve", 2, "b".repeat(limits.maxSessionBytes)]);
    expect(account(["pull", 2])).toBe("bytes");
  });

  it("charges a string past Latin-1 two bytes a character", () => {
    const narrow = fresh();
    const wide = fresh();
    const length = Math.floor(limits.maxSessionBytes / 1.5);
    expect(narrow.account(["push", "a".repeat(length)])).toBeUndefined();
    expect(wide.account(["push", "\u0100".repeat(length)])).toBe("bytes");
  });
});

describe("streams and pipes the peer may not open", () => {
  it("ends the session on a stream or a pipe", () => {
    expect(fresh().account(["stream", "chunk"])).toBe("stream");
    expect(fresh().account(["pipe"])).toBe("stream");
  });
});

describe("our own stubs passed back", () => {
  it("costs nothing to refer back to stubs we sent, but a promise we sent costs an answer", () => {
    const { account, recordSent } = fresh();
    // We hand the peer five stubs (sessions, subscriptions) and a promise.
    recordSent([
      "resolve",
      7,
      [
        [
          ["export", -1],
          ["export", -2],
          ["export", -3],
          ["export", -4],
          ["export", -5],
          ["promise", -6],
        ],
      ],
    ]);
    // Five stubs back in one call copy no data, so they cost nothing.
    expect(
      account([
        "push",
        [
          "pipeline",
          0,
          ["use"],
          [
            ["pipeline", -1],
            ["pipeline", -2],
            ["pipeline", -3],
            ["pipeline", -4],
            ["pipeline", -5],
          ],
        ],
      ])
    ).toBeUndefined();
    // The promise we sent settles to our answer: priced as one.
    expect(
      account([
        "push",
        [
          [
            ["pipeline", -6],
            ["pipeline", -6],
            ["pipeline", -6],
            ["pipeline", -6],
            ["pipeline", -6],
          ],
        ],
      ])
    ).toBe("copy");
  });
});

describe("messages the peer may not send", () => {
  it("ends the session on a remap", () => {
    const { account } = fresh();
    expect(account(["push", ["remap", 1, [], [], [["pipeline", 0]]]])).toBe(
      "remap"
    );
  });

  it("ends the session on a flood of tiny inline nodes", () => {
    const { account } = fresh();
    const many = Array.from({ length: limits.maxMessageNodes + 50 }, () => 0);
    expect(account(["push", [[many]]])).toBe("nodes");
  });

  it("ends the session on a message that isn't an array", () => {
    const { account } = fresh();
    expect(account({ not: "an array" })).toBe("bad-message");
    expect(account(["totally-unknown-kind"])).toBe("bad-message");
    expect(account(["push"])).toBe("bad-message");
  });

  it("caps how many of the peer's exports are live at once", () => {
    const { account } = fresh();
    const outcomes: (string | undefined)[] = [];
    for (let i = 0; i < limits.maxLiveExports + 2; i += 1) {
      outcomes.push(account(["push", "x"]));
    }
    expect(outcomes.at(-1)).toBe("exports");
  });
});

describe("what every session in an isolate holds together", () => {
  it("ends the session that takes the pool past its limit, not the others", () => {
    const pool = heldPool(limits.maxSessionBytes);
    const first = messageAccountant(limits, pool);
    const second = messageAccountant(limits, pool);
    const third = messageAccountant(limits, pool);
    const most = "a".repeat(Math.floor(limits.maxSessionBytes * 0.6));
    const outcomes = [
      // Each within its own budget; the second takes the pool past it, and
      // ends, letting go of what it held (as the transport does on refusal).
      first.account(["push", most]),
      (() => {
        const refusal = second.account(["push", most]);
        second.dispose();
        return refusal;
      })(),
      // The first goes on.
      first.account(["push", ["pipeline", 0, ["ping"], []]]),
      // Once the first's push is released, a third has room.
      first.account(["release", 1, 1]),
      third.account(["push", most]),
    ];
    expect(outcomes).toStrictEqual([
      undefined,
      "isolate",
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("what a value referring to another keeps alive", () => {
  it("charges a reference what the referred export holds, so releasing the original frees nothing it kept", () => {
    const { account } = fresh();
    // Push a large string, refer to it from a new export, release the
    // original, again and again: each reference keeps the string alive.
    const large = "a".repeat(Math.floor(limits.maxSessionBytes * 0.4));
    const outcomes: (string | undefined)[] = [];
    let id = 0;
    for (let round = 0; round < 6; round += 1) {
      outcomes.push(account(["push", `${large}${round}`]));
      id += 1;
      const original = id;
      outcomes.push(account(["push", ["pipeline", original]]));
      id += 1;
      outcomes.push(account(["release", original, 1]));
    }
    expect(outcomes).toContain("bytes");
  });
});

describe("answers we send", () => {
  it("refuses, in the session that sends it, an answer that takes the isolate past its limit", () => {
    const pool = heldPool(limits.maxSessionBytes);
    const sessions = [1, 2, 3].map(() => messageAccountant(limits, pool));
    const answer = "s".repeat(Math.floor(limits.maxSessionBytes * 0.4));
    const outcomes = sessions.map((session) => {
      session.account(["push", ["pipeline", 0, ["source"], []]]);
      return session.recordSent(["resolve", 1, answer]);
    });
    // The first two fit; the third answer would take the pool past it.
    expect(outcomes).toStrictEqual([undefined, undefined, "isolate"]);
  });
});

describe("our own stubs as the peer releases them", () => {
  it("forgets a stub of ours at its last release, however many come and go", () => {
    const { account, recordSent } = fresh();
    const outcomes: (string | undefined)[] = [];
    // A fresh stub each time, as a new subscription is, then released.
    for (let round = 1; round <= 1000; round += 1) {
      outcomes.push(
        account(["push", ["pipeline", 0, ["watch"], []]]),
        recordSent(["resolve", round, ["export", -round]]),
        account(["release", -round, 1]),
        account(["release", round, 1])
      );
    }
    expect(outcomes.every((outcome) => outcome === undefined)).toBeTruthy();
    // Released, the first is unknown again: priced as an answer, not free.
    expect(
      account([
        "push",
        [
          [
            ["pipeline", -1],
            ["pipeline", -1],
            ["pipeline", -1],
            ["pipeline", -1],
            ["pipeline", -1],
          ],
        ],
      ])
    ).toBe("copy");
  });

  it("ends the session on a release of more counts than we gave", () => {
    const { account, recordSent } = fresh();
    recordSent([
      "resolve",
      1,
      [
        [
          ["export", -1],
          ["export", -1],
        ],
      ],
    ]);
    expect(account(["release", -1, 3])).toBe("release");
  });
});
