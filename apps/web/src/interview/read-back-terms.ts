import type { InterviewLine } from "@grasp-os/shared/interview-links";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import type { IconData } from "@grasp-os/ui/lib/icons";

import {
  AnthropicLogo,
  GoogleLogo,
  MicrosoftLogo,
  MistralLogo,
  OpenAiLogo,
} from "../connections/brand-logos.ts";

// Concepts only, for the read-back told as a story (read-back-story.tsx):
// the things a line names, found in its words, to stand in it as pills.
// Core sends a line's words alone, no spans, so the page finds them: the
// tools people name most, each with its maker's mark where the product
// draws one, and what Stephen marked in their own words in the
// conversation (`InterviewLine.marks`), where the line says it again.

/** A thing a line names: how it is written, and its maker's mark when the product has one. */
export interface Term {
  logo: IconData | null;
}

/**
 * The tools named most in work, as they are written, with their maker's
 * mark. Found in any case, but for a name that is also an everyday word
 * ("Teams", "Word", "Exact"): that one only as the tool writes it.
 */
const tools: readonly { name: string; logo: IconData | null; word?: true }[] = [
  { name: "Microsoft 365", logo: MicrosoftLogo },
  { name: "Copilot", logo: MicrosoftLogo },
  { name: "Excel", logo: MicrosoftLogo },
  { name: "Outlook", logo: MicrosoftLogo },
  { name: "Teams", logo: MicrosoftLogo, word: true },
  { name: "Word", logo: MicrosoftLogo, word: true },
  { name: "PowerPoint", logo: MicrosoftLogo },
  { name: "SharePoint", logo: MicrosoftLogo },
  { name: "OneDrive", logo: MicrosoftLogo },
  { name: "ChatGPT", logo: OpenAiLogo },
  { name: "OpenAI", logo: OpenAiLogo },
  { name: "Claude", logo: AnthropicLogo, word: true },
  { name: "Mistral", logo: MistralLogo, word: true },
  { name: "Le Chat", logo: MistralLogo, word: true },
  { name: "Gemini", logo: GoogleLogo, word: true },
  { name: "Gmail", logo: GoogleLogo },
  { name: "Google Drive", logo: GoogleLogo },
  { name: "Google Docs", logo: GoogleLogo },
  { name: "Google Sheets", logo: GoogleLogo },
  { name: "DeepSeek", logo: null },
  { name: "Perplexity", logo: null, word: true },
  { name: "Slack", logo: null, word: true },
  { name: "Notion", logo: null, word: true },
  { name: "Jira", logo: null },
  { name: "Confluence", logo: null, word: true },
  { name: "Salesforce", logo: null },
  { name: "HubSpot", logo: null },
  { name: "SAP", logo: null, word: true },
  { name: "AFAS", logo: null },
  { name: "Exact", logo: null, word: true },
  { name: "Zendesk", logo: null },
];

/** The tool `words` name, if they name one as it is written. */
const toolOf = (words: string) =>
  tools.find(({ name, word }) =>
    word === true ? name === words : name.toLowerCase() === words.toLowerCase()
  );

/** What a mark of theirs may be to stand as a pill: a name or a short phrase, not a clause. */
const pillWords = 4;
const pillLength = 40;

/** The tags whose marks name a tool: where the work is done, and their own list or tool. */
const toolTags: ReadonlySet<FactTag> = new Set(["system", "workaround"]);

/**
 * What Stephen marked in their words, short enough to be a pill: with
 * `all`, every kind (tasks, wishes, what goes wrong); without, only the
 * tools.
 */
export const markedTerms = (
  lines: readonly InterviewLine[],
  all: boolean
): string[] =>
  lines.flatMap(({ marks }) =>
    (marks ?? []).flatMap(({ quote, tag }) => {
      const words = quote.trim();
      const short =
        words.length > 1 &&
        words.length <= pillLength &&
        words.split(/\s+/u).length <= pillWords;
      return short && (all || toolTags.has(tag)) ? [words] : [];
    })
  );

/** A piece of a line: its words, and the thing they name when they name one. */
export interface StoryPiece {
  at: number;
  text: string;
  term: Term | null;
}

const escaped = (words: string): string =>
  words.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/**
 * `text` in pieces, each thing it names (a tool, or one of `marked`) a
 * piece of its own, matched as whole words in any case: "Excel" in
 * "Excel-sheet" is a thing, in "excellent" it is not.
 */
export const storyPieces = (
  text: string,
  marked: readonly string[] = []
): StoryPiece[] => {
  const names = [...new Set([...tools.map(({ name }) => name), ...marked])]
    .filter((name) => name.trim() !== "")
    // The longest first: "Google Drive" before "Google".
    .toSorted((one, other) => other.length - one.length)
    .map(escaped);
  const found = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(?:${names.join("|")})(?![\p{L}\p{N}])`,
    "giu"
  );
  const pieces: StoryPiece[] = [];
  let at = 0;
  for (const match of text.matchAll(found)) {
    const [words] = match;
    const tool = toolOf(words);
    const mark = marked.some(
      (name) => name.toLowerCase() === words.toLowerCase()
    );
    if (tool !== undefined || mark) {
      if (match.index > at) {
        pieces.push({ at, text: text.slice(at, match.index), term: null });
      }
      pieces.push({
        at: match.index,
        text: words,
        term: { logo: tool?.logo ?? null },
      });
      at = match.index + words.length;
    }
  }
  if (at < text.length) {
    pieces.push({ at, text: text.slice(at), term: null });
  }
  return pieces;
};
