/**
 * The security review a release's limit evidence names (GRA-942): every
 * pull request merged since the release published before it that touched
 * the platform limits or a capacity workload, each with its approval by a
 * CODEOWNER, as GitHub's API reports them (evidence-release.ts fetches).
 *
 * What it proves, and what it must not:
 * - Every change between the two releases' commits that could raise a
 *   limit, or change what proves one, was reviewed: not only the pull
 *   request merged as the release's commit. An unreviewed raise (merged
 *   by an admin's bypass, say, its own publish failing) never ships on the
 *   approval of a later, unrelated one; nor does one among a burst of
 *   merges published together. A release that raises a limit with no such
 *   change between them is refused.
 * - Each pull request is the one GitHub merged into main as exactly that
 *   commit (`merge_commit_sha`): one merged elsewhere, or whose merge made
 *   another commit, proves nothing.
 * - Each approval is a CODEOWNER's, on the pull request's final head (an
 *   approval of an earlier push says nothing about what merged), the
 *   reviewer's latest word on it, and no CODEOWNER's latest word on it is
 *   changes requested.
 * - CODEOWNERS is read as it was before the merge (the merge commit's
 *   first parent): a pull request that edits CODEOWNERS can't name its own
 *   owners. Only its catch-all rule (`*`) is resolved: one with any other
 *   rule is refused rather than matched by hand, since a path rule could
 *   name other owners for the files a raise touches.
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
  const ownersLatest = [...latest].filter(([login]) => owners.includes(login));
  // A CODEOWNER who asked for changes, as their latest word, holds it back.
  if (ownersLatest.some(([, review]) => review.state === "CHANGES_REQUESTED")) {
    throw new Error(
      `Pull request #${pull.number} has a CODEOWNER's changes requested`
    );
  }
  for (const [login, review] of ownersLatest) {
    if (review.state === "APPROVED" && review.commit_id === pull.head.sha) {
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

/** What the security review reads of GitHub (evidence-release.ts, or a test's fake). */
export interface ReviewSource {
  /** The commits after `base` up to `head` on main, oldest first. */
  commitsBetween: (base: string, head: string) => Promise<string[]>;
  /**
   * A commit's files and first parent, and whether the files were cut
   * short (GitHub lists at most 300 a commit): one cut short counts as
   * touching what's watched.
   */
  commit: (
    sha: string
  ) => Promise<{ files: string[]; parent: string; truncated: boolean }>;
  /** The pull requests GitHub associates with a commit. */
  pullsOf: (sha: string) => Promise<unknown>;
  /** A pull request's reviews. */
  reviewsOf: (pullRequest: number) => Promise<unknown>;
  /** CODEOWNERS as it was at a commit. */
  codeownersAt: (sha: string) => Promise<string>;
}

/** Whether `file` is one of `watched`: a path, or under a folder (`dir/`). */
const isWatched = (file: string, watched: readonly string[]): boolean =>
  watched.some((path) =>
    path.endsWith("/") ? file.startsWith(path) : file === path
  );

/**
 * The security reviews of every change since `base` up to `head` that
 * touched `watched` (the platform limits, the capacity workloads), oldest
 * first, each its pull request merged as that commit and a CODEOWNER's
 * approval with CODEOWNERS as it was before. Throws for one without, and
 * when none touched them: a raise needs the change that made it reviewed.
 */
export const securityReviewsSince = async (
  source: ReviewSource,
  base: string,
  head: string,
  watched: readonly string[]
): Promise<SecurityReview[]> => {
  const reviews: SecurityReview[] = [];
  for (const sha of await source.commitsBetween(base, head)) {
    // oxlint-disable-next-line no-await-in-loop -- one commit at a time, a few a release
    const { files, parent, truncated } = await source.commit(sha);
    if (!truncated && !files.some((file) => isWatched(file, watched))) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    const pull = mergedAs(await source.pullsOf(sha), sha);
    // oxlint-disable-next-line no-await-in-loop -- as above
    const owners = catchAllOwners(await source.codeownersAt(parent));
    // oxlint-disable-next-line no-await-in-loop -- as above
    const reviewed = await source.reviewsOf(pull.number);
    reviews.push(ownerApproval(pull, reviewed, owners));
  }
  if (reviews.length === 0) {
    throw new Error(
      `No change between ${base} and ${head} touched the platform limits or a capacity workload: nothing reviewed raised them`
    );
  }
  return reviews;
};
