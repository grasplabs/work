// How much review a pull request gets, from the files it changes: a
// complexity (Low, Medium or High) and, beside it, whether it touches
// security. High and Security PRs get Greptile's review; Low and Medium
// ones are reviewed in the session that wrote them, to save Greptile's
// per-review cost (October 2026, GRA-1116). CI labels each PR with the result
// (.github/workflows/review-tier.yml):
//
//   gh api repos/<repo>/pulls/<n>/files --paginate \
//     --jq '.[] | {filename, additions, deletions}' | node scripts/review-tier.ts
//
// Read from the paths and line counts only, the same way on every push,
// so neither an author nor a PR's text can talk a PR into less review.
import { readFileSync } from "node:fs";

import { z } from "zod";

export type Complexity = "Low" | "Medium" | "High";

/** A changed file, as GitHub's pull request files API lists it. */
export interface ChangedFile {
  readonly filename: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface Assessment {
  readonly complexity: Complexity;
  readonly security: boolean;
  /** Why, one line each, for the job's log and summary. */
  readonly reasons: readonly string[];
}

/** Written by tools, reviewed through what generates them. */
const generated =
  /(?:^|\/)(?:pnpm-lock\.yaml|worker-configuration\.d\.ts|routeTree\.gen\.ts|messages\.po|catalog\.d\.ts)$|\/migrations\/meta\/|^scripts\/(?:test|e2e)-durations\.json$/u;

const testFile = /\.(?:test|e2e)\.tsx?$|(?:^|\/)(?:test|e2e)\//u;

/**
 * Where a change is a security change whatever it does: sign-in, and what
 * CI and the repository's rules trust. Tests don't count here or below: a
 * test can't open a hole. This is a floor, from names alone: most security
 * changes (who may read what, an audience's threshold) sit in ordinary
 * files, and the session that wrote the PR adds the label for them.
 */
const securityPaths: readonly RegExp[] = [
  /^apps\/core\/src\/auth\//u,
  /^\.github\/(?:workflows|rulesets)\/|^\.github\/CODEOWNERS$/u,
  /^\.secretlintrc\.json$/u,
];

/**
 * Server code named for what it guards. The frontend and the UI kit are
 * left out: their `tokens` are the theme's, and the boundaries they show
 * are enforced in core.
 */
const guardedServerCode =
  /^(?:apps\/(?!web\/)[^/]+|packages\/(?!ui\/)[^/]+)\/src\/(?:.*[/-])?(?:auth|permissions?|sandbox(?:ed)?|secrets?|tokens?|oauth|egress|isolate|sealed?|grants?|rights|keys?|signing|security|session-check|idp|audit-chain)(?:[-./]|$)/u;

/** Code lines above which a PR is High, and up to which it can be Low. */
const highLines = 1000;
const lowLines = 80;
/** A test line weighs a quarter of a code line: it can't break the product. */
const testWeight = 0.25;
/** Apps or packages a High PR spans, at least. */
const highAreas = 4;

/** `apps/core`, `packages/sdk`, or the repository's root. */
const areaOf = (filename: string): string => {
  const [top, name] = filename.split("/");
  return (top === "apps" || top === "packages") && name !== undefined
    ? `${top}/${name}`
    : "root";
};

const linesOf = (files: readonly ChangedFile[]): number => {
  let lines = 0;
  for (const { additions, deletions } of files) {
    lines += additions + deletions;
  }
  return lines;
};

export const assess = (files: readonly ChangedFile[]): Assessment => {
  const reviewed = files.filter(({ filename }) => !generated.test(filename));
  const code = reviewed.filter(({ filename }) => !testFile.test(filename));
  const codeLines = linesOf(code);
  const weighted =
    codeLines + Math.round((linesOf(reviewed) - codeLines) * testWeight);
  const areas = new Set(code.map(({ filename }) => areaOf(filename)));
  const guarded = code.filter(({ filename }) =>
    [...securityPaths, guardedServerCode].some((path) => path.test(filename))
  );

  const reasons = [
    `${codeLines} code lines, ${weighted} weighted with tests, in ${areas.size} ${areas.size === 1 ? "area" : "areas"}`,
  ];
  for (const { filename } of guarded.slice(0, 5)) {
    reasons.push(`security: ${filename}`);
  }

  let complexity: Complexity = "Medium";
  if (weighted > highLines || areas.size >= highAreas) {
    complexity = "High";
  } else if (weighted <= lowLines && areas.size <= 1) {
    complexity = "Low";
  }
  return { complexity, security: guarded.length > 0, reasons };
};

const fileSchema = z.object({
  filename: z.string(),
  additions: z.number(),
  deletions: z.number(),
});

/** One changed file per line, as `gh api --jq '.[] | …'` prints them. */
export const parseFiles = (text: string): ChangedFile[] =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => fileSchema.parse(JSON.parse(line)));

if (import.meta.main) {
  const { complexity, security, reasons } = assess(
    parseFiles(readFileSync(0, "utf-8"))
  );
  console.log(JSON.stringify({ complexity, security, reasons }));
}
