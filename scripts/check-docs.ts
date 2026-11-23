/**
 * Keeps dev docs out of the repo: plans, ADRs and design notes live
 * outside it. Fails on any Markdown file that isn't on the allowlist. The
 * SDK docs are the one body of docs allowed, and only their content
 * folder: they ship with each release (apps/docs).
 */
import { execFileSync } from "node:child_process";

const MARKDOWN = /\.mdx?$/iu;

const ALLOWED = [
  /^README\.md$/u,
  /^AGENTS\.md$/u,
  /^\.github\/[^/]+\.md$/u,
  // Skills are product content the platform loads, not docs.
  /(?:^|\/)skills\//u,
  // The SDK docs' pages, which every deployment serves at /docs.
  /^apps\/docs\/content\//u,
  // The pages of the stand-in docs core's tests serve, as Markdown.
  /^apps\/core\/test\/fixtures\/assets\/docs\//u,
];

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf-8" }
)
  .split("\n")
  .filter((file) => MARKDOWN.test(file));

const disallowed = files.filter(
  (file) => !ALLOWED.some((pattern) => pattern.test(file))
);

if (disallowed.length > 0) {
  console.error(
    `Dev docs are kept out of the repo. Move these elsewhere:\n${disallowed.map((file) => `  ${file}`).join("\n")}`
  );
  process.exit(1);
}
