import { useFollowLinks } from "../frame/follow-links.ts";
import { PageBrain } from "../grasp/blocks/page-brain/page-brain.tsx";
import type {
  PageFact,
  PageOpenQuestion,
} from "../grasp/page-properties/index.ts";
import { escapeMarkdown } from "./brain-markdown.ts";
import {
  isTeamClaim,
  mentionParts,
  statementWords,
  teamClaimBasis,
} from "./brain.ts";
import type { Note } from "./brain.ts";

// A note's page as a Brain page (the library's page-brain, Ruben's pick D):
// its title, its facts and open questions behind Properties, and what Grasp
// wrote of it as the page's text. Read only until core keeps a page per
// note (core need 47); then the text is edited in place.

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
      ? `*${escapeMarkdown(teamClaimBasis())}*`
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

/** Keeps nothing: the page is read only. */
const unchanged = () => {
  // Nothing is written until core keeps a page per note (core need 47).
};

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
  const followLinks = useFollowLinks();
  return (
    <div ref={followLinks}>
      <PageBrain
        facts={facts}
        onValueChange={unchanged}
        readOnly
        title={
          note.kind === "statement"
            ? statementWords(note.id, note.title)
            : note.title
        }
        value={text ?? noteText(note, byId)}
        {...(questions === undefined ? {} : { questions })}
      />
    </div>
  );
};
