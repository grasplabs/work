/**
 * The security review a release's limit evidence names (GRA-942): the
 * pull request merged as the release's commit, and its approval by a
 * CODEOWNER, as GitHub's API reports them (evidence-release.ts fetches).
 *
 * What it proves, and what it must not:
 * - The pull request is the one GitHub merged into main as exactly the
 *   release's commit (`merge_commit_sha`): one merged elsewhere, or whose
 *   merge made another commit, proves nothing for it.
 * - The approval is a CODEOWNER's, on the pull request's final head (an
 *   approval of an earlier push says nothing about what merged), and the
 *   reviewer's latest word on it (one approval later withdrawn, or
 *   followed by changes requested, isn't an approval).
 * - CODEOWNERS is read at the release's commit. Only its catch-all rule
 *   (`*`) is resolved: one with any other rule is refused rather than
 *   matched by hand, since a path rule could name other owners for the
 *   files a raise touches.
 */
import { z } from "zod";

/** A security review, as the evidence names it. */
export interface SecurityReview {
  pullRequest: number;
  approvedBy: string;
}

const loginSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u);

/**
 * The owners CODEOWNERS (`text`) names for every file, by GitHub login.
 * Throws for a file with a rule other than `*`, or teams or addresses as
 * owners: they aren't resolved here.
 */
export const catchAllOwners = (text: string): string[] => {
  const owners: string[] = [];
  for (const line of text.split("\n")) {
    const rule = line.replace(/#.*$/u, "").trim();
    if (rule === "") {
      continue;
    }
    const [pattern, ...named] = rule.split(/\s+/u);
    if (pattern !== "*") {
      throw new Error(
        `CODEOWNERS has a rule for ${pattern ?? "nothing"}: only \`*\` is resolved for limit evidence`
      );
    }
    for (const owner of named) {
      const login = /^@(?<login>[^/]+)$/u.exec(owner)?.groups?.login;
      if (login === undefined || !loginSchema.safeParse(login).success) {
        throw new Error(
          `CODEOWNERS names ${owner}: only users are resolved for limit evidence`
        );
      }
      owners.push(login.toLowerCase());
    }
  }
  if (owners.length === 0) {
    throw new Error("CODEOWNERS names no owner");
  }
  return owners;
};

const pullSchema = z.object({
  number: z.int().positive(),
  merged_at: z.string().nullable(),
  merge_commit_sha: z.string().nullable(),
  base: z.object({ ref: z.string() }),
  head: z.object({ sha: z.string() }),
});

const reviewSchema = z.object({
  user: z.object({ login: z.string() }).nullable(),
  state: z.string(),
  commit_id: z.string().nullable(),
  submitted_at: z.string().nullable(),
});

/** The pull request merged into `base` as exactly `commit`, of `pulls`. */
export const mergedAs = (
  pulls: unknown,
  commit: string,
  base = "main"
): z.infer<typeof pullSchema> => {
  const merged = z
    .array(pullSchema)
    .parse(pulls)
    .filter(
      (pull) =>
        pull.merged_at !== null &&
        pull.merge_commit_sha === commit &&
        pull.base.ref === base
    );
  const [pull] = merged;
  if (pull === undefined || merged.length > 1) {
    throw new Error(
      `${merged.length === 0 ? "No" : "More than one"} pull request merged into ${base} as ${commit}`
    );
  }
  return pull;
};

/**
 * The security review of `pull`: a CODEOWNER (`owners`) whose latest
 * review is an approval of its final head, of its `reviews`. Throws when
 * there's none.
 */
export const ownerApproval = (
  pull: z.infer<typeof pullSchema>,
  reviews: unknown,
  owners: readonly string[]
): SecurityReview => {
  const latest = new Map<string, z.infer<typeof reviewSchema>>();
  const decided = z
    .array(reviewSchema)
    .parse(reviews)
    // Comments don't change what a reviewer decided.
    .filter(({ state }) => state !== "COMMENTED" && state !== "PENDING")
    .toSorted((one, other) =>
      (one.submitted_at ?? "").localeCompare(other.submitted_at ?? "")
    );
  for (const review of decided) {
    if (review.user !== null) {
      latest.set(review.user.login.toLowerCase(), review);
    }
  }
  for (const [login, review] of latest) {
    if (
      owners.includes(login) &&
      review.state === "APPROVED" &&
      review.commit_id === pull.head.sha
    ) {
      return {
        pullRequest: pull.number,
        approvedBy: review.user?.login ?? login,
      };
    }
  }
  throw new Error(
    `Pull request #${pull.number} has no CODEOWNER's approval of its final head (${pull.head.sha})`
  );
};
