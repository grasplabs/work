import type { InterviewLine } from "@grasp-os/shared/interview-links";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import type { IconData } from "@grasp-os/ui/lib/icons";

import {
  AnthropicLogo,
  ClaudeLogo,
  DeepSeekLogo,
  GeminiLogo,
  GmailLogo,
  GoogleDocsLogo,
  GoogleLogo,
  GoogleSheetsLogo,
  HubSpotLogo,
  JiraLogo,
  MicrosoftLogo,
  MistralLogo,
  OpenAiLogo,
  PerplexityLogo,
  SapLogo,
  ZendeskLogo,
} from "../connections/brand-logos.ts";

// Concepts only, for the read-back told as a story (read-back-story.tsx):
// the things a line names, found in its words, to stand in it as pills.
// Core sends a line's words alone, no spans, so the page finds them: the
// tools people name most, each with its maker's mark where the product
// draws one, and what Stephen marked in their own words in the
// conversation (`InterviewLine.marks`), where the line says it again.

/**
 * A thing a line names, and its maker's own mark when the product has one:
 * drawn (`logo`, from brand-logos.ts) or a whole logo file in its own
 * colours (`src`, from `public/logos`, as the setup's source and HR tiles
 * show them).
 */
export interface Term {
  logo: IconData | null;
  src: string | null;
  /** `src` is the name written as its maker writes it (AFAS), shown in place of the words. */
  wordmark: boolean;
}

interface Tool {
  name: string;
  logo?: IconData;
  src?: string;
  wordmark?: true;
  /** Also an everyday word ("Teams", "Exact"): found only as the tool writes it. */
  word?: true;
}

/**
 * The tools named most in work, as they are written, with their maker's
 * mark. Excel, Outlook, Word and PowerPoint carry their own app icons
 * (public/logos/microsoft-*.svg, from vscode-icons, MIT); Copilot and
 * Microsoft 365, Microsoft's.
 */
const tools: readonly Tool[] = [
  { name: "Microsoft 365", logo: MicrosoftLogo },
  { name: "Copilot", logo: MicrosoftLogo },
  { name: "Excel", src: "/logos/microsoft-excel.svg" },
  { name: "Outlook", src: "/logos/microsoft-outlook.svg" },
  { name: "Teams", src: "/logos/microsoft-teams.svg", word: true },
  { name: "Word", src: "/logos/microsoft-word.svg", word: true },
  { name: "PowerPoint", src: "/logos/microsoft-powerpoint.svg" },
  { name: "SharePoint", src: "/logos/microsoft-sharepoint.svg" },
  { name: "OneDrive", src: "/logos/microsoft-onedrive.svg" },
  { name: "ChatGPT", logo: OpenAiLogo },
  { name: "OpenAI", logo: OpenAiLogo },
  { name: "Claude", logo: ClaudeLogo, word: true },
  { name: "Anthropic", logo: AnthropicLogo },
  { name: "Mistral", logo: MistralLogo, word: true },
  { name: "Le Chat", logo: MistralLogo, word: true },
  { name: "Gemini", logo: GeminiLogo, word: true },
  { name: "Gmail", logo: GmailLogo },
  { name: "Google Drive", src: "/logos/google-drive.svg" },
  { name: "Google Docs", logo: GoogleDocsLogo },
  { name: "Google Sheets", logo: GoogleSheetsLogo },
  { name: "Google", logo: GoogleLogo, word: true },
  { name: "DeepSeek", logo: DeepSeekLogo },
  { name: "Perplexity", logo: PerplexityLogo, word: true },
  { name: "Slack", src: "/logos/slack.svg", word: true },
  { name: "Notion", src: "/logos/notion.svg", word: true },
  { name: "Jira", logo: JiraLogo },
  { name: "Confluence", src: "/logos/confluence.svg", word: true },
  { name: "Salesforce" },
  { name: "HubSpot", logo: HubSpotLogo },
  { name: "SAP", logo: SapLogo, word: true },
  { name: "AFAS", src: "/logos/afas.svg", wordmark: true },
  { name: "Personio", src: "/logos/personio.svg" },
  { name: "HiBob", src: "/logos/hibob.svg" },
  { name: "Nmbrs", src: "/logos/nmbrs.svg" },
  { name: "Loket", src: "/logos/loket.svg", word: true },
  { name: "Workday", src: "/logos/workday.svg", word: true },
  { name: "Exact", word: true },
  { name: "Zendesk", logo: ZendeskLogo },
  { name: "Dropbox", src: "/logos/dropbox.svg", word: true },
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
        term: {
          logo: tool?.logo ?? null,
          src: tool?.src ?? null,
          wordmark: tool?.wordmark === true,
        },
      });
      at = match.index + words.length;
    }
  }
  if (at < text.length) {
    pieces.push({ at, text: text.slice(at), term: null });
  }
  return pieces;
};

/** The words of a text that carry its meaning: four letters or more, in lower case. */
const meaningful = (text: string): Set<string> =>
  new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter(
      (word) => word.length >= 4
    )
  );

/**
 * What they said in the conversation that a line of the read-back comes
 * from, as near as its words tell: their own line that shares the most
 * words with it (what Stephen marked in it counting double), or none when
 * no line shares a word. Core keeps no link from a line to what was said,
 * so this is the page's best guess, shown as a hint, never as a record.
 */
export const sourceOf = (
  text: string,
  lines: readonly InterviewLine[]
): string | null => {
  const wanted = meaningful(text);
  let best: { said: string; score: number } | null = null;
  for (const line of lines) {
    if (line.from !== "person" || line.removed === true) {
      continue;
    }
    const shared = (words: Set<string>) =>
      [...words].filter((word) => wanted.has(word)).length;
    const score =
      shared(meaningful(line.text)) +
      2 *
        shared(
          meaningful((line.marks ?? []).map(({ quote }) => quote).join(" "))
        );
    if (score > 0 && (best === null || score > best.score)) {
      best = { said: line.text, score };
    }
  }
  return best?.said ?? null;
};
