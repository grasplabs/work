import type { Transcript } from "@grasp-os/shared/brain";
import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";

import { formatDay } from "../format.ts";
import { folderName, given, kindLabel, quoted } from "./brain.ts";
import type { Note, NoteEvent, NoteRef } from "./brain.ts";
import { chapterOfTurns, placeLabel } from "./transcript.ts";

interface ExportOptions {
  /** Where Grasp runs, so links in the file open the note or workflow there. */
  baseUrl: string;
  /** ISO date of the export. */
  exportedOn: string;
  /** A source's conversation, exported word for word after its article. */
  transcript?: Transcript;
}

const notWord = /[^a-z0-9]+/gu;
/** What Markdown reads as markup anywhere in a line: emphasis, code, links, images, HTML, tables, strikethrough. */
const inlineMarkup = /[\\`*_[\]<>!|~]/gu;
/** What Markdown reads as a block when a line starts with it: a heading, a heading's underline (`===`, `---`), a quote, a list item. */
const blockStart = /^(?<indent>\s*)(?<mark>[#>+=-])/gmu;
/** A numbered list item at a line's start: "1." or "1)". */
const orderedStart = /^(?<number>\s*\d+)(?<mark>[.)])/gmu;
/** Brackets, which `encodeURIComponent` leaves as they are and which would end a link's address. */
const brackets = /[()]/gu;
const encodedBrackets: Record<string, string> = { "(": "%28", ")": "%29" };
/** Line breaks, which would end a heading, a list item or the frontmatter early. */
const lineBreaks = /\s*[\r\n]+\s*/gu;
const edgeDashes = /^-|-$/gu;
const lastDash = /-$/u;

/**
 * Text from the brain's records (titles, names, what was said), as Markdown
 * shows it and never reads it: every character that would make it a link,
 * an image, emphasis or a block escaped. A name such as `![](https://…)`
 * stays a name, and the export never loads anything it names. A bare
 * address or mail address may still become a link in a GFM reader, which
 * finds them in the text after escapes, but such a link shows exactly
 * where it goes: no label hides another address.
 */
export const escapeMarkdown = (text: string): string =>
  text
    .replaceAll(inlineMarkup, "\\$&")
    .replaceAll(blockStart, "$<indent>\\$<mark>")
    .replaceAll(orderedStart, "$<number>\\$<mark>");

/** A YAML string on one line, for the frontmatter: quoted, so a `:`, `#` or `,` stays in it. */
const yamlString = (text: string): string =>
  JSON.stringify(text.replaceAll(lineBreaks, " "));

/** Text for one line: its line breaks as spaces, then escaped. */
const inline = (text: string): string =>
  escapeMarkdown(text.replaceAll(lineBreaks, " "));

/** An id or other part of a link's address, encoded so it can't end the link. */
const pathPart = (part: string): string =>
  encodeURIComponent(part).replaceAll(
    brackets,
    (bracket) => encodedBrackets[bracket] ?? bracket
  );

/** A file name for a note, without its extension: its title in plain words, cut to a sensible length. */
export const noteFileName = (note: Note): string => {
  const name = note.title
    .toLowerCase()
    .replaceAll(notWord, "-")
    .replaceAll(edgeDashes, "")
    .slice(0, 60)
    .replace(lastDash, "");
  return name || note.id;
};

/** A point's label with its colon, as the export puts it before the value: "Before:". */
const labelled = (label: string): string =>
  t({
    message: `${label}:`,
    comment:
      'A label before its value, as in "Owner: Finance". Keep the colon where your language puts it.',
  });

/** A transcript, chapter by chapter, every turn with its place and speaker. */
const transcriptLines = (transcript: Transcript): string[] => {
  const lines = ["", `## ${t`Transcript`}`];
  const chapterOf = chapterOfTurns(transcript);
  for (const [index, turn] of transcript.turns.entries()) {
    const number = chapterOf[index] ?? 0;
    const chapter = transcript.chapters[number];
    if (chapter && (index === 0 || number !== chapterOf[index - 1])) {
      lines.push(
        "",
        `### ${inline(chapter.title)} · ${inline(placeLabel(transcript, chapter.at))}`
      );
    }
    lines.push(
      "",
      `**${inline(placeLabel(transcript, turn.at))} · ${inline(turn.speaker)}:** ${escapeMarkdown(turn.text)}`
    );
  }
  return lines;
};

/**
 * A note as Markdown with its full history: every point, the article and transcript, every timeline event with
 * its quotes, what is still open and everything it links to. Nothing is folded, as it is on screen.
 * Headings and labels are in the reader's language; the frontmatter keys stay English, so other
 * tools can read them.
 */
export const noteMarkdown = (
  note: Note,
  { baseUrl, exportedOn, transcript }: ExportOptions
): string => {
  const link = (ref: NoteRef) => {
    const label = inline(ref.label);
    if (given(ref.workflowId)) {
      return `[${label}](${baseUrl}/workflows/${pathPart(ref.workflowId)})`;
    }
    if (given(ref.policyId)) {
      return `[${label}](${baseUrl}/policies/documents/${pathPart(ref.policyId)})`;
    }
    if (given(ref.to)) {
      const statement = given(ref.statement)
        ? `#${pathPart(ref.statement)}`
        : "";
      return `[${label}](${baseUrl}/brain/${pathPart(ref.to)}${statement})`;
    }
    return label;
  };
  /** A link to where something was said in a source. */
  const quoteLink = (text: string, sourceId: string, statementId: string) =>
    `[${inline(quoted(text))}](${baseUrl}/brain/${pathPart(sourceId)}#${pathPart(statementId)})`;
  const eventLine = (entry: NoteEvent) => [
    `- **${formatDay(entry.date)}** · ${link({ label: entry.title, to: entry.to, workflowId: entry.workflowId })}${given(entry.detail) ? ` · ${inline(entry.detail)}` : ""}`,
    ...entry.quotes.map(
      (each) => `  - ${quoteLink(each.text, each.sourceId, each.statementId)}`
    ),
  ];

  const lines = [
    "---",
    `id: ${yamlString(note.id)}`,
    `kind: ${yamlString(i18n._(kindLabel[note.kind]))}`,
    `folder: ${yamlString(note.path.length > 0 ? note.path.map(folderName).join(" / ") : t`Vault root`)}`,
    `tags: [${note.tags.map(yamlString).join(", ")}]`,
    `exported: ${exportedOn}`,
    "---",
    "",
    `# ${inline(note.kind === "statement" ? quoted(note.title) : note.title)}`,
    "",
    escapeMarkdown(note.summary),
    "",
    ...note.points.map(
      (point) =>
        `- **${inline(labelled(point.label))}** ${point.refs.map(link).join(", ")}`
    ),
  ];

  if (note.article) {
    lines.push(
      "",
      `## ${t`Article`}`,
      "",
      note.article.map(escapeMarkdown).join("\n\n")
    );
  }
  if (transcript) {
    lines.push(...transcriptLines(transcript));
  }

  lines.push("", `## ${t`Timeline`}`, "", ...note.timeline.flatMap(eventLine));
  if (note.open.length > 0) {
    lines.push(
      "",
      `### ${t({ message: "Open", context: "on a timeline: not happened yet" })}`,
      "",
      ...note.open.map((item) => `- ${inline(item)}`)
    );
  }

  if (note.linked.length > 0 || note.mentions.length > 0) {
    lines.push("", `## ${t`Linked`}`);
    for (const group of note.linked) {
      lines.push(
        "",
        `### ${inline(group.title)}`,
        "",
        ...group.refs.map((ref) => `- ${link(ref)}`)
      );
    }
    if (note.mentions.length > 0) {
      lines.push(
        "",
        `### ${t`Named, not linked`}`,
        "",
        ...note.mentions.map(
          (mention) =>
            `- ${quoteLink(mention.text, mention.sourceId, mention.statementId)}`
        )
      );
    }
  }

  return `${lines.join("\n")}\n`;
};
