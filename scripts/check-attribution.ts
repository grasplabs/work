/**
 * Commits on main name only the people who wrote them: no AI co-author
 * trailers, "Generated with" footers or links to an agent's session. The
 * commit-msg hook checks each commit; CI checks the PR description and every
 * commit of the PR, because the squash commit on main is the description
 * plus a Co-authored-by trailer for each co-author of those commits.
 *
 * usage: check-attribution.ts [file]   reads stdin without a file
 */
import { readFileSync } from "node:fs";

/** Co-authors that are AI tools, by name or by email. */
const aiCoAuthor =
  /^\s*co-authored-by:.*\b(?:claude|anthropic|openai|chatgpt|codex|copilot|cursor|gemini|aider|devin)\b/iu;

/** Footers and trailers agents add to what they write. */
const aiFooters: readonly RegExp[] = [
  /generated (?:with|by) \[?(?:claude|codex|cursor|copilot|gemini|aider|devin)/iu,
  /^\s*claude-session:/iu,
  /https:\/\/claude\.ai\/code\/session_/u,
];

/** The lines of `text` that credit an AI tool, numbered from 1. */
export const findAiAttribution = (
  text: string
): { line: number; text: string }[] =>
  text
    .split("\n")
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter(
      ({ text: line }) =>
        aiCoAuthor.test(line) || aiFooters.some((footer) => footer.test(line))
    );

if (import.meta.main) {
  const [file] = process.argv.slice(2);
  const found = findAiAttribution(readFileSync(file ?? 0, "utf-8"));
  if (found.length > 0) {
    console.error(
      `Remove the AI attribution; commits name only the people who wrote them:\n${found
        .map(({ line, text }) => `  ${line}: ${text}`)
        .join(
          "\n"
        )}\nClaude Code: set "attribution": { "commit": "", "pr": "" } in your settings.`
    );
    process.exit(1);
  }
}
