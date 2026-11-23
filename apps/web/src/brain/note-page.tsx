import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Heading } from "@grasp-os/ui/components/heading";
import { Link } from "@grasp-os/ui/components/link";
import { Markdown } from "@grasp-os/ui/components/markdown";
import type { MarkdownLink } from "@grasp-os/ui/components/markdown";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link as RouterLink } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { ReactNode } from "react";

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

// A note's page as a Brain page (the prototype's page D, Ruben's pick): its
// title, its facts and open questions behind Properties, and what Grasp
// wrote of it as the page's text, drawn by Damsko's Markdown. Read only
// until core keeps a page per note (core need 47).

const styles = stylex.create({
  // The reading column, about 44rem, with room before it where an edited page has its gutter
  // (none on a phone).
  page: {
    boxSizing: "border-box",
    width: "100%",
    maxWidth: {
      default: `calc(44rem + ${space["16"]})`,
      [media.maxSm]: "44rem",
    },
    marginInline: "auto",
    paddingBlockStart: { default: space["8"], [media.maxSm]: space["2"] },
    paddingBlockEnd: space["16"],
    paddingInlineStart: { default: space["16"], [media.maxSm]: 0 },
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
  },
  body: { marginBlockStart: space["3"] },
});

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

/** Where a link to another note of the brain points: the address `noteText` writes for it. */
const notePrefix = "/brain/";

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
          : `[${escapeMarkdown(part.label)}](${notePrefix}${encodeURIComponent(part.id)})`
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
 * that what was said is gathered on. A source shows what was said in it on page D, under its own
 * words.
 */
export const onArticle = (note: Note): boolean =>
  note.kind === "team" ||
  (note.kind !== "source" &&
    note.kind !== "company" &&
    note.statementIds.length > 0);

/**
 * A link out of Grasp in a note's text: it opens in its own tab, without
 * this page as its opener, only once the person says so, as a link in an
 * answer does. A note's text may come from a source or a chat.
 */
const LeavingLink = ({ link }: { link: MarkdownLink }) => {
  const { t } = useLingui();
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Link
        href={link.href}
        onClick={(event) => {
          event.preventDefault();
          setAsking(true);
        }}
        variant="underline"
      >
        {link.children}
      </Link>
      <AlertDialog
        onOpenChange={(open, { returnValue }) => {
          setAsking(open);
          if (!open && returnValue === "open") {
            window.open(link.href, "_blank", "noopener,noreferrer");
          }
        }}
        open={asking}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Open external link?`}</AlertDialogTitle>
            <AlertDialogDescription>{link.href}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel />
            <AlertDialogAction value="open">{t`Open link`}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

/**
 * The text's links: another note of the brain through the router, in this
 * tab; a web address through its question first; anything else as its words
 * (Markdown's own).
 */
const noteLink = (link: MarkdownLink): ReactNode => {
  if (link.type !== "image" && link.href.startsWith(notePrefix)) {
    const noteId = decodeURIComponent(link.href.slice(notePrefix.length));
    return (
      <Link asChild variant="underline">
        <RouterLink params={{ noteId }} to="/brain/$noteId">
          {link.children}
        </RouterLink>
      </Link>
    );
  }
  const web =
    link.type !== "image" &&
    (link.scheme === "http" || link.scheme === "https");
  return web ? <LeavingLink link={link} /> : undefined;
};

/** No questions wait on the note. */
const noQuestions: readonly PageOpenQuestion[] = [];

export const NoteBrainPage = ({
  note,
  byId,
  facts,
  questions = noQuestions,
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
  const title =
    note.kind === "statement"
      ? statementWords(note.id, note.title)
      : note.title;
  return (
    <article aria-labelledby={titleId} {...stylex.props(styles.page)}>
      <Heading id={titleId} level={1}>
        {title}
      </Heading>
      <PageProperties facts={facts} questions={questions} />
      <div {...stylex.props(styles.body)}>
        <Markdown headingLevel={2} renderLink={noteLink}>
          {text ?? noteText(note, byId)}
        </Markdown>
      </div>
    </article>
  );
};
