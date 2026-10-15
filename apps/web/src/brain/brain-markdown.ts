import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";

import { formatDay } from "../format.ts";
import { folderName, given, kindLabel, quoted } from "./brain.ts";
import type { Note, NoteEvent, NoteRef } from "./brain.ts";
import { chapterOfTurns, placeLabel } from "./transcript.ts";
import type { Transcript } from "./workspace.ts";

interface ExportOptions {
  /** Where Grasp runs, so links in the file open the note or workflow there. */
  baseUrl: string;
  /** ISO date of the export. */
  exportedOn: string;
  /** A source's conversation, exported word for word after its article. */
  transcript?: Transcript;
}

const notWord = /[^a-z0-9]+/gu;
const edgeDashes = /^-|-$/gu;
const lastDash = /-$/u;

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
        `### ${chapter.title} · ${placeLabel(transcript, chapter.at)}`
      );
    }
    lines.push(
      "",
      `**${placeLabel(transcript, turn.at)} · ${turn.speaker}:** ${turn.text}`
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
    if (given(ref.workflowId)) {
      return `[${ref.label}](${baseUrl}/workflows/${ref.workflowId})`;
    }
    if (given(ref.policyId)) {
      return `[${ref.label}](${baseUrl}/policies/documents/${ref.policyId})`;
    }
    if (given(ref.to)) {
      const statement = given(ref.statement) ? `#${ref.statement}` : "";
      return `[${ref.label}](${baseUrl}/brain/${ref.to}${statement})`;
    }
    return ref.label;
  };
  const eventLine = (entry: NoteEvent) => [
    `- **${formatDay(entry.date)}** · ${link({ label: entry.title, to: entry.to, workflowId: entry.workflowId })}${given(entry.detail) ? ` · ${entry.detail}` : ""}`,
    ...entry.quotes.map(
      (each) =>
        `  - [${quoted(each.text)}](${baseUrl}/brain/${each.sourceId}#${each.statementId})`
    ),
  ];

  const lines = [
    "---",
    `id: ${note.id}`,
    `kind: ${i18n._(kindLabel[note.kind])}`,
    `folder: ${note.path.length > 0 ? note.path.map(folderName).join(" / ") : t`Vault root`}`,
    `tags: [${note.tags.join(", ")}]`,
    `exported: ${exportedOn}`,
    "---",
    "",
    `# ${note.kind === "statement" ? quoted(note.title) : note.title}`,
    "",
    note.summary,
    "",
    ...note.points.map(
      (point) =>
        `- **${labelled(point.label)}** ${point.refs.map(link).join(", ")}`
    ),
  ];

  if (note.article) {
    lines.push("", `## ${t`Article`}`, "", note.article.join("\n\n"));
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
      ...note.open.map((item) => `- ${item}`)
    );
  }

  if (note.linked.length > 0 || note.mentions.length > 0) {
    lines.push("", `## ${t`Linked`}`);
    for (const group of note.linked) {
      lines.push(
        "",
        `### ${group.title}`,
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
            `- [${quoted(mention.text)}](${baseUrl}/brain/${mention.sourceId}#${mention.statementId})`
        )
      );
    }
  }

  return `${lines.join("\n")}\n`;
};
