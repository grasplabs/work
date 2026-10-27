import { describe, expect, it } from "vite-plus/test";

import { catchAllOwners, mergedAs, ownerApproval } from "./review-lib.ts";

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
        /has no CODEOWNER's approval of its final head/u
      );
    }
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
