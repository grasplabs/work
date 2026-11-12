/**
 * Commits on main name only the people who wrote them: no AI co-author
 * trailers, "Generated with" footers or links to an agent's session. The
 * commit-msg hook checks each commit; CI checks the PR description and every
 * commit of the PR and its title, because the squash commit on main is the
 * title, the description and a Co-authored-by trailer for each co-author of
 * those commits. A commit whose author is an agent (Claude Code on the web,
 * Cursor's or Codex's cloud agents, Copilot's coding agent) becomes such a
 * trailer, so the hook and CI pass each commit's author in as a
 * Co-authored-by line.
 *
 * usage: check-attribution.ts [file]   reads stdin without a file
 */
import { readFileSync } from "node:fs";

/** AI coding tools and their makers, as they appear in names, emails and bot logins. */
const aiTools =
  "claude|anthropic|openai|chatgpt|codex|copilot|cursor|gemini|google-labs-jules|aider|devin|windsurf|codeium|opencode|ampcode|warp\\.dev|warp-agent|openhands|all-hands|charm\\.land|amazon-q-developer|factory-droid";

/** Co-authors that are AI tools, by name, email or bot login. */
const aiCoAuthor = new RegExp(
  `^\\s*co-authored-by:.*\\b(?:${aiTools})\\b`,
  "iu"
);

/**
 * Footers and trailers agents add to what they write. A footer opens its
 * line, after any emoji or Markdown around it ("🤖 ", "_", "> **"), so a
 * sentence that quotes one is left alone.
 */
const aiFooters: readonly RegExp[] = [
  new RegExp(
    `^[^\\p{L}\\p{N}]*generated (?:with|by) \\[?(?:${aiTools}|crush)\\b`,
    "iu"
  ),
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
        )}\nCommit as yourself: set your git user.name and user.email where the agent runs (in a cloud agent, its git identity setting), and turn off its attribution (Claude Code: "attribution": { "commit": "", "pr": "" } in your settings).`
    );
    process.exit(1);
  }
}
