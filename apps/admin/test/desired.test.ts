import { describe, expect, it } from "vite-plus/test";

import {
  isSecretsBehind,
  parallelDeploys,
  planChannel,
  promotableReleases,
  promotionRefusal,
  stateOf,
  targetOf,
} from "../src/rollout/desired.ts";
import type { ClientFacts, Promotion } from "../src/rollout/desired.ts";

// What every client should run, and which moves a channel may make
// (src/rollout/desired.ts). How it can go wrong:
// - a release skipping a channel (Edge straight to Stable);
// - a channel unable to go back to a release it had;
// - a pinned client deployed to its channel's release;
// - a failed client deployed again before staff retry;
// - more than the cap deploying on one channel at once.

const releases = { edge: "26.11.3", beta: "26.11.2", stable: "26.11.1" };

const client = (overrides: Partial<ClientFacts> = {}): ClientFacts => ({
  id: "a",
  channel: "stable",
  pinnedReleaseId: null,
  running: "26.11.1",
  secretsBehind: false,
  deploy: null,
  ...overrides,
});

describe("a client's target", () => {
  it("is its pin, else its channel's release, else none", () => {
    expect(targetOf(client(), releases)).toBe("26.11.1");
    expect(targetOf(client({ pinnedReleaseId: "26.10.9" }), releases)).toBe(
      "26.10.9"
    );
    expect(targetOf(client(), { ...releases, stable: null })).toBeNull();
  });
});

describe("moving a channel", () => {
  const history: Promotion[] = [
    { channel: "edge", releaseId: "26.11.1" },
    { channel: "beta", releaseId: "26.11.1" },
    { channel: "stable", releaseId: "26.11.1" },
    { channel: "edge", releaseId: "26.11.2" },
    { channel: "beta", releaseId: "26.11.2" },
    { channel: "edge", releaseId: "26.11.3" },
  ];

  it("goes Edge, then Beta, then Stable, never skipping one", () => {
    expect(promotionRefusal("beta", "26.11.3", "26.11.2", history)).toBeNull();
    expect(
      promotionRefusal("stable", "26.11.2", "26.11.1", history)
    ).toBeNull();
    expect(promotionRefusal("stable", "26.11.3", "26.11.1", history)).toBe(
      "not_on_previous_channel"
    );
  });

  it("goes back only to a release the channel itself had", () => {
    expect(promotionRefusal("beta", "26.11.1", "26.11.2", history)).toBeNull();
    expect(promotionRefusal("edge", "26.11.1", "26.11.3", history)).toBeNull();
    expect(promotionRefusal("edge", "26.10.1", "26.11.3", history)).toBe(
      "not_on_previous_channel"
    );
    expect(promotionRefusal("beta", "26.11.2", "26.11.2", history)).toBe(
      "current"
    );
  });

  it("offers only the moves it may make, newest first", () => {
    const listed = ["26.11.3", "26.11.2", "26.11.1", "26.10.1"];
    expect(
      promotableReleases("stable", "26.11.1", history, listed)
    ).toStrictEqual(["26.11.2"]);
    expect(
      promotableReleases("beta", "26.11.2", history, listed)
    ).toStrictEqual(["26.11.3", "26.11.1"]);
  });
});

describe("where a client stands", () => {
  it("is waiting off its target or its rolled-out secrets, and deploying while a deploy is out", () => {
    expect(stateOf(client(), releases)).toBe("up_to_date");
    expect(stateOf(client({ running: "26.10.9" }), releases)).toBe("waiting");
    expect(stateOf(client({ secretsBehind: true }), releases)).toBe("waiting");
    expect(
      stateOf(
        client({
          running: "26.10.9",
          deploy: { releaseId: "26.11.1", status: "deploying", error: null },
        }),
        releases
      )
    ).toBe("deploying");
  });

  it("is failed until retried on its target alone, and without one has no release", () => {
    expect(
      stateOf(
        client({
          running: "26.10.9",
          deploy: { releaseId: "26.11.1", status: "failed", error: "x" },
        }),
        releases
      )
    ).toBe("failed");
    // A failure on a release it no longer targets says nothing.
    expect(
      stateOf(
        client({
          running: "26.10.9",
          deploy: { releaseId: "26.10.8", status: "failed", error: "x" },
        }),
        releases
      )
    ).toBe("waiting");
    expect(stateOf(client(), { ...releases, stable: null })).toBe("no_release");
  });
});

describe("a channel's plan", () => {
  const waiting = (count: number): ClientFacts[] =>
    Array.from({ length: count }, (_, index) =>
      client({ id: `c${String(index).padStart(3, "0")}`, running: "26.10.9" })
    );

  it(`starts at most ${parallelDeploys} at once, counting those out`, () => {
    expect(planChannel(waiting(40), releases, 0, false).start).toHaveLength(
      parallelDeploys
    );
    expect(planChannel(waiting(40), releases, 20, false).start).toHaveLength(
      parallelDeploys - 20
    );
    expect(
      planChannel(waiting(40), releases, parallelDeploys, false).start
    ).toStrictEqual([]);
  });

  it("starts nothing once the channel failed", () => {
    expect(planChannel(waiting(3), releases, 0, true).start).toStrictEqual([]);
  });
});

describe("shared secrets behind", () => {
  it("is a held secret whose fingerprint isn't the rolled-out one, and never before a rollout", () => {
    const delivered = { connect: { A: "1", B: "2" } };
    expect(isSecretsBehind(delivered, null)).toBeFalsy();
    expect(isSecretsBehind(delivered, { A: "1", B: "2", C: "3" })).toBeFalsy();
    expect(isSecretsBehind(delivered, { A: "1", B: "9" })).toBeTruthy();
  });
});
