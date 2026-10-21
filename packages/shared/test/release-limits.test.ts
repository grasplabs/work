import { describe, expect, it } from "vite-plus/test";

import {
  limitRaises,
  uncoveredRaise,
  verifyLimitEvidence,
} from "../src/release.ts";
import type { LimitEvidence, ReleaseLimits } from "../src/release.ts";

const commit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const releaseId = "r000200-aaaaaaa";

const evidence = (
  limit: string,
  raisedTo: number | null,
  overrides: Partial<LimitEvidence> = {}
): LimitEvidence => ({
  limit,
  raisedTo,
  commit,
  releaseId,
  profile: "cloudflare",
  capacityRun: { jobId: 1, commit, profile: overrides.profile ?? "cloudflare" },
  securityReview: { pullRequest: 7, approvedBy: "nickruigrok" },
  ...overrides,
});

/** A release raising `workflowSteps` from 1000 to 2000. */
const raising = (limitEvidence: LimitEvidence[]): ReleaseLimits => ({
  releaseId,
  commit,
  platformLimits: { workflowSteps: 2000, workflowBranches: 8 },
  previousRelease: {
    releaseId: "r000199-bbbbbbb",
    platformLimits: { workflowSteps: 1000, workflowBranches: 8 },
  },
  limitEvidence,
});

describe("platform limit raises", () => {
  it("are the limits that went up or were dropped, never new or lowered ones", () => {
    expect(
      limitRaises(
        { up: 1, same: 2, down: 3, dropped: 4 },
        { up: 5, same: 2, down: 1, added: 9 }
      )
    ).toStrictEqual([
      { limit: "up", raisedTo: 5 },
      { limit: "dropped", raisedTo: null },
    ]);
  });
});

describe("a release's limit evidence", () => {
  it("is accepted when it covers each raise for the release's own commit and id", () => {
    expect(() => {
      verifyLimitEvidence(
        raising([
          evidence("workflowSteps", 2000),
          evidence("workflowSteps", 2000, { profile: "workerd" }),
        ])
      );
    }).not.toThrow();
  });

  it("refuses a raise with none", () => {
    expect(() => {
      verifyLimitEvidence(raising([]));
    }).toThrow(/raises workflowSteps to 2000 without/u);
  });

  it("refuses evidence replayed from another commit, release or capacity run", () => {
    const replays: [Partial<LimitEvidence>, RegExp][] = [
      [{ commit: otherCommit }, /is for commit b+, not the release's/u],
      [{ releaseId: "r000199-bbbbbbb" }, /is for release r000199-bbbbbbb/u],
      [
        {
          capacityRun: {
            jobId: 1,
            commit: otherCommit,
            profile: "cloudflare",
          },
        },
        /is for commit b+, not the release's/u,
      ],
      [
        { capacityRun: { jobId: 1, commit, profile: "workerd" } },
        /names a capacity run on workerd/u,
      ],
    ];
    for (const [replay, refusal] of replays) {
      expect(() => {
        verifyLimitEvidence(raising([evidence("workflowSteps", 2000, replay)]));
      }).toThrow(refusal);
    }
  });

  it("refuses evidence for another value, a limit it doesn't raise, or given twice", () => {
    expect(() => {
      verifyLimitEvidence(raising([evidence("workflowSteps", 1500)]));
    }).toThrow(/vouches for 1500/u);
    expect(() => {
      verifyLimitEvidence(
        raising([
          evidence("workflowSteps", 2000),
          evidence("workflowBranches", 8),
        ])
      );
    }).toThrow(/doesn't raise/u);
    expect(() => {
      verifyLimitEvidence(
        raising([
          evidence("workflowSteps", 2000),
          evidence("workflowSteps", 2000),
        ])
      );
    }).toThrow(/twice/u);
  });

  it("needs evidence that drops a limit it drops", () => {
    const dropping: ReleaseLimits = {
      ...raising([]),
      platformLimits: { workflowSteps: 1000 },
    };
    expect(() => {
      verifyLimitEvidence(dropping);
    }).toThrow(/unbounded/u);
    expect(() => {
      verifyLimitEvidence({
        ...dropping,
        limitEvidence: [evidence("workflowBranches", null)],
      });
    }).not.toThrow();
  });

  it("takes the first release that records limits as raising nothing", () => {
    expect(() => {
      verifyLimitEvidence({ ...raising([]), previousRelease: null });
    }).not.toThrow();
  });
});

describe("evidence covering a client's raise", () => {
  const from = { workflowSteps: 1000, workflowBranches: 8 };

  it("needs an entry for the client's profile that raised the limit at least as far", () => {
    const to = { workflowSteps: 2000, workflowBranches: 8 };
    const raise = { limit: "workflowSteps", raisedTo: 2000 };
    expect(uncoveredRaise(from, to, [], "cloudflare")).toStrictEqual(raise);
    expect(
      uncoveredRaise(
        from,
        to,
        [evidence("workflowSteps", 2000, { profile: "workerd" })],
        "cloudflare"
      )
    ).toStrictEqual(raise);
    expect(
      uncoveredRaise(from, to, [evidence("workflowSteps", 1500)], "cloudflare")
    ).toStrictEqual(raise);
    expect(
      uncoveredRaise(from, to, [evidence("workflowSteps", 3000)], "cloudflare")
    ).toBeUndefined();
  });

  it("covers a dropped limit only with evidence that drops it", () => {
    const to = { workflowSteps: 1000 };
    expect(
      uncoveredRaise(
        from,
        to,
        [evidence("workflowBranches", 1_000_000)],
        "cloudflare"
      )
    ).toStrictEqual({ limit: "workflowBranches", raisedTo: null });
    expect(
      uncoveredRaise(
        from,
        to,
        [evidence("workflowBranches", null)],
        "cloudflare"
      )
    ).toBeUndefined();
  });
});

describe("evidence across several releases", () => {
  it("is the last raise's: a limit lowered and raised again needs evidence from the release that raised it again", () => {
    const from = { workflowSteps: 1000 };
    const to = { workflowSteps: 2000 };
    const first = evidence("workflowSteps", 2000, {
      releaseId: "r000100-aaaaaaa",
    });
    const again = evidence("workflowSteps", 2000, {
      releaseId: "r000300-aaaaaaa",
      profile: "workerd",
    });
    expect(
      uncoveredRaise(from, to, [first, again], "cloudflare")
    ).toStrictEqual({ limit: "workflowSteps", raisedTo: 2000 });
    expect(
      uncoveredRaise(from, to, [again, first], "cloudflare")
    ).toBeUndefined();
  });
});
