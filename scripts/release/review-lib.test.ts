import { describe, expect, it } from "vite-plus/test";

import {
  catchAllOwners,
  mergedAs,
  ownerApproval,
  securityReviewsSince,
} from "./review-lib.ts";
import type { ReviewSource } from "./review-lib.ts";

// The security review a release's limit evidence names (GRA-942), from
// what must not count first: a pull request merged elsewhere or as
// another commit; an approval by someone who isn't a CODEOWNER, of an
// earlier push, or later withdrawn; CODEOWNERS rules not resolved here.

const commit = "a".repeat(40);
const head = "b".repeat(40);

const pull = (overrides: Record<string, unknown> = {}) => ({
  number: 42,
  merged_at: "2026-10-27T10:00:00Z",
  merge_commit_sha: commit,
  base: { ref: "main" },
  head: { sha: head },
  ...overrides,
});

const review = (login: string, state: string, at: string, commitId = head) => ({
  user: { login },
  state,
  commit_id: commitId,
  submitted_at: at,
});

const owners = catchAllOwners(
  "# Every pull request needs one of these.\n*  @nickruigrok @jkobgnther\n"
);

describe("the security review of a release's change", () => {
  it("is the pull request merged into main as the release's commit, approved on its final head by a CODEOWNER", () => {
    expect(
      ownerApproval(
        mergedAs([pull({ number: 41, merged_at: null }), pull()], commit),
        [
          review("someone", "APPROVED", "2026-10-27T09:00:00Z"),
          review("NickRuigrok", "APPROVED", "2026-10-27T09:30:00Z"),
        ],
        owners
      )
    ).toStrictEqual({ pullRequest: 42, approvedBy: "NickRuigrok" });
  });

  it("refuses a pull request merged elsewhere, or as another commit", () => {
    expect(() =>
      mergedAs([pull({ base: { ref: "release" } })], commit)
    ).toThrow(/No pull request merged into main/u);
    expect(() =>
      mergedAs([pull({ merge_commit_sha: "c".repeat(40) })], commit)
    ).toThrow(/No pull request merged into main/u);
  });

  it("refuses an approval by someone who isn't a CODEOWNER, of an earlier push, or followed by changes requested", () => {
    const merged = mergedAs([pull()], commit);
    const attempts = [
      [review("someone", "APPROVED", "2026-10-27T09:00:00Z")],
      [
        review(
          "nickruigrok",
          "APPROVED",
          "2026-10-27T09:00:00Z",
          "d".repeat(40)
        ),
      ],
      [
        review("nickruigrok", "APPROVED", "2026-10-27T09:00:00Z"),
        review("nickruigrok", "CHANGES_REQUESTED", "2026-10-27T09:10:00Z"),
      ],
    ];
    for (const reviews of attempts) {
      expect(() => ownerApproval(merged, reviews, owners)).toThrow(
        /has no CODEOWNER's approval of its final head|has a CODEOWNER's changes requested/u
      );
    }
  });

  it("refuses an approval while another CODEOWNER's latest word is changes requested", () => {
    expect(() =>
      ownerApproval(
        mergedAs([pull()], commit),
        [
          review("nickruigrok", "APPROVED", "2026-10-27T09:00:00Z"),
          review("jkobgnther", "CHANGES_REQUESTED", "2026-10-27T09:10:00Z"),
        ],
        owners
      )
    ).toThrow(/has a CODEOWNER's changes requested/u);
  });

  it("keeps an approval a later comment follows", () => {
    expect(
      ownerApproval(
        mergedAs([pull()], commit),
        [
          review("jkobgnther", "APPROVED", "2026-10-27T09:00:00Z"),
          review("jkobgnther", "COMMENTED", "2026-10-27T09:10:00Z"),
        ],
        owners
      ).approvedBy
    ).toBe("jkobgnther");
  });

  it("resolves only CODEOWNERS' catch-all rule, and only users", () => {
    expect(() =>
      catchAllOwners("*  @nickruigrok\n/apps/ @jkobgnther\n")
    ).toThrow(/has a rule for \/apps\//u);
    expect(() => catchAllOwners("*  @grasplabs/owners\n")).toThrow(
      /only users are resolved/u
    );
    expect(() => catchAllOwners("# none\n")).toThrow(/names no owner/u);
  });
});

/** Main between two releases, as GitHub would answer for it. */
const mainBetween = (
  merges: {
    sha: string;
    files: string[];
    number: number;
    reviews: unknown[];
    codeowners?: string;
    truncated?: boolean;
  }[]
): ReviewSource => ({
  commitsBetween: async () =>
    await Promise.resolve(merges.map(({ sha }) => sha)),
  commit: async (sha) => {
    const merge = merges.find((each) => each.sha === sha);
    return await Promise.resolve({
      files: merge?.files ?? [],
      parent: `parent-of-${sha}`,
      truncated: merge?.truncated ?? false,
    });
  },
  pullsOf: async (sha) => {
    const merge = merges.find((each) => each.sha === sha);
    return await Promise.resolve([
      pull({ number: merge?.number, merge_commit_sha: sha }),
    ]);
  },
  reviewsOf: async (number) =>
    await Promise.resolve(
      merges.find((each) => each.number === number)?.reviews ?? []
    ),
  codeownersAt: async (sha) => {
    const merge = merges.find((each) => `parent-of-${each.sha}` === sha);
    return await Promise.resolve(
      merge?.codeowners ?? "* @nickruigrok @jkobgnther\n"
    );
  },
});

const watched = ["packages/shared/src/platform-limits.ts", "scripts/capacity/"];
const approved = [review("jkobgnther", "APPROVED", "2026-10-27T09:00:00Z")];

describe("the security review of every change between two releases", () => {
  it("names each approved change to the limits or a workload, oldest first, and passes over the rest", async () => {
    await expect(
      securityReviewsSince(
        mainBetween([
          {
            sha: "1".repeat(40),
            files: ["packages/shared/src/platform-limits.ts"],
            number: 10,
            reviews: approved,
          },
          {
            sha: "2".repeat(40),
            files: ["apps/web/src/x.tsx"],
            number: 11,
            reviews: [],
          },
          {
            sha: commit,
            files: ["scripts/capacity/workloads.ts"],
            number: 12,
            reviews: approved,
          },
        ]),
        "0".repeat(40),
        commit,
        watched
      )
    ).resolves.toStrictEqual([
      { pullRequest: 10, approvedBy: "jkobgnther" },
      { pullRequest: 12, approvedBy: "jkobgnther" },
    ]);
  });

  it("refuses an unreviewed raise that an approved, unrelated change follows", async () => {
    await expect(
      securityReviewsSince(
        mainBetween([
          // Merged by an admin's bypass, with no approval.
          {
            sha: "1".repeat(40),
            files: ["packages/shared/src/platform-limits.ts"],
            number: 10,
            reviews: [],
          },
          {
            sha: commit,
            files: ["apps/web/src/x.tsx"],
            number: 12,
            reviews: approved,
          },
        ]),
        "0".repeat(40),
        commit,
        watched
      )
    ).rejects.toThrow(/#10 has no CODEOWNER's approval/u);
  });

  it("reads CODEOWNERS from before the merge, so a change can't name its own owners", async () => {
    await expect(
      securityReviewsSince(
        mainBetween([
          {
            sha: commit,
            files: [
              "packages/shared/src/platform-limits.ts",
              ".github/CODEOWNERS",
            ],
            number: 12,
            // Approved by someone the change itself made an owner.
            reviews: [review("someone", "APPROVED", "2026-10-27T09:00:00Z")],
            codeowners: "* @nickruigrok @jkobgnther\n",
          },
        ]),
        "0".repeat(40),
        commit,
        watched
      )
    ).rejects.toThrow(/no CODEOWNER's approval/u);
  });

  it("counts a commit whose files GitHub cut short as touching the limits", async () => {
    await expect(
      securityReviewsSince(
        mainBetween([
          {
            sha: "1".repeat(40),
            files: ["apps/web/src/x.tsx"],
            number: 10,
            reviews: [],
            truncated: true,
          },
          {
            sha: commit,
            files: ["packages/shared/src/platform-limits.ts"],
            number: 12,
            reviews: approved,
          },
        ]),
        "0".repeat(40),
        commit,
        watched
      )
    ).rejects.toThrow(/#10 has no CODEOWNER's approval/u);
  });

  it("refuses a raise no reviewed change between the releases made", async () => {
    await expect(
      securityReviewsSince(
        mainBetween([
          {
            sha: commit,
            files: ["apps/web/src/x.tsx"],
            number: 12,
            reviews: approved,
          },
        ]),
        "0".repeat(40),
        commit,
        watched
      )
    ).rejects.toThrow(/nothing reviewed raised them/u);
  });
});
