import { Heading } from "@grasp-os/ui/components/heading";
import { Link as TextLink } from "@grasp-os/ui/components/link";
import { Markdown } from "@grasp-os/ui/components/markdown";
import type { MarkdownLink } from "@grasp-os/ui/components/markdown";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import type { ReactNode } from "react";

import { LeavingLink } from "../chat/answer-words.tsx";
import { escapeMarkdown } from "./brain-markdown.ts";
import {
  isTeamClaim,
  mentionParts,
  statementWords,
  teamClaimBasis,
} from "./brain.ts";
import type { Note } from "./brain.ts";
import { PageProperties } from "./page-properties.tsx";
import type { PageFact, PageOpenQuestion } from "./page-properties.tsx";

// A note's page as a Brain page (the reference library's page-brain,
// Ruben's pick D): its title, its facts and open questions behind
// Properties, and what Grasp wrote of it as the page's text. Read only
// until core keeps a page per note (core need 47); then the text is edited
// in place. The text is Damsko's Markdown: a link to another page of Grasp
// opens it in place, a link out of Grasp asks first, as an answer's do.

const styles = stylex.create({
  // The reading column, about 44rem, with room before it for an editor's gutter (none on a
  // phone, where the gutter gives way).
  page: {
    boxSizing: "border-box",
    width: "100%",
    maxWidth: {
      default: `calc(44rem + ${space["16"]})`,
      [media.maxSm]: "44rem",
    },
    marginInline: "auto",
    paddingBlockStart: {
      default: space["8"],
      [media.maxSm]: space["2"],
    },
    paddingBlockEnd: space["16"],
    paddingInlineStart: { default: space["16"], [media.maxSm]: 0 },
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
  },
  body: { marginBlockStart: space["3"], minHeight: space["20"] },
});

/** The links out of Grasp a click may open, after the person says yes. */
const leavingSchemes: ReadonlySet<string> = new Set([
  "http",
  "https",
  "mailto",
]);

/** A link in a note's text: to a page of Grasp, in place; out of Grasp, asked first; else its words. */
const noteLink = (link: MarkdownLink): ReactNode => {
  if (link.type === "image") {
    return <span>{link.children}</span>;
  }
  if (
    link.scheme === "" &&
    link.href.startsWith("/") &&
    !link.href.startsWith("//")
  ) {
    return (
      <TextLink asChild>
        <Link to={link.href}>{link.children}</Link>
      </TextLink>
    );
  }
  return leavingSchemes.has(link.scheme) || link.href.startsWith("//") ? (
    <LeavingLink href={link.href}>{link.children}</LeavingLink>
  ) : (
    <span>{link.children}</span>
  );
};

/**
 * The notes the text may name, as links: everything around this note and in its properties, but
 * the statements and sources, which have their own places. The company is always nameable: the
 * longest name wins, so "Noordkade Finance" never reads as the Finance team.
 */
export const nameableFrom = (
  note: Note,
  byId: ReadonlyMap<string, Note>
): Note[] =>
  [
    ...new Set([
      "company",
      ...note.links,
      ...note.backlinks,
      ...note.points.flatMap((point) =>
        point.refs.flatMap((ref) => (ref.to === undefined ? [] : [ref.to]))
      ),
    ]),
  ]
    .map((id) => byId.get(id))
    .filter(
      (candidate): candidate is Note =>
        candidate !== undefined &&
        candidate.kind !== "statement" &&
        candidate.kind !== "source"
    );

/**
 * What Grasp wrote of the note, as the page's text: its summary, what a team's claim rests on, and
 * an interview's write-up with the notes it names as links, each the first time a paragraph names
 * it. Records are escaped, so a name never reads as Markdown.
 */
const noteText = (note: Note, byId: ReadonlyMap<string, Note>): string => {
  const nameable = nameableFrom(note, byId);
  const linked = (paragraph: string): string =>
    mentionParts(paragraph, nameable)
      .map((part) =>
        typeof part === "string"
          ? escapeMarkdown(part)
          : `[${escapeMarkdown(part.label)}](/brain/${encodeURIComponent(part.id)})`
      )
      .join("");
  return [
    escapeMarkdown(note.summary),
    note.kind === "statement" && isTeamClaim(note.id)
      ? `*${escapeMarkdown(teamClaimBasis(note.id))}*`
      : "",
    ...(note.article ?? []).map(linked),
  ]
    .filter((paragraph) => paragraph !== "")
    .join("\n\n");
};

/**
 * Whether the note keeps its article (`brain-article/`) instead of page D: a team, and a subject
 * that what was said is gathered on, until Ruben picks between D and the library's parked
 * BrainSubject for them. A source shows what was said in it on page D, under its own words.
 */
export const onArticle = (note: Note): boolean =>
  note.kind === "team" ||
  (note.kind !== "source" &&
    note.kind !== "company" &&
    note.statementIds.length > 0);

export const NoteBrainPage = ({
  note,
  byId,
  facts,
  questions,
  text,
}: {
  note: Note;
  byId: ReadonlyMap<string, Note>;
  facts: readonly PageFact[];
  questions?: readonly PageOpenQuestion[];
  /** The page's text, when it is not what Grasp wrote of the note, such as the company's. */
  text?: string;
}) => {
  const titleId = useId();
  return (
    <article
      aria-labelledby={titleId}
      data-slot="page-brain"
      {...stylex.props(styles.page)}
    >
      <Heading id={titleId} level={1}>
        {note.kind === "statement"
          ? statementWords(note.id, note.title)
          : note.title}
      </Heading>
      <PageProperties facts={facts} questions={questions} />
      <div {...stylex.props(styles.body)}>
        <Markdown renderLink={noteLink}>
          {text ?? noteText(note, byId)}
        </Markdown>
      </div>
    </article>
  );
};
