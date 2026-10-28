import { allowedFor } from "@grasp-os/brain/authorize";
import type { Brain } from "@grasp-os/brain/brain";
import { collections, documents, sections } from "@grasp-os/brain/schema";
import { citedSnippetMax } from "@grasp-os/shared/chat";
import type { ChatCitedDocument, ChatCitedSpan } from "@grasp-os/shared/chat";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { NoteLink } from "../chat-messages.ts";
import { inList } from "../db/d1.ts";
import { cut } from "./catalog.ts";

// The documents a chat's answer cites, as the person it is for sees them:
// core's chat convention over Knowledge's documents (workspace.ts).

/** A run of whitespace, which a snippet shows as one space. */
const whitespace = /\s+/gu;

/**
 * The sections a cited document's snippet may come from, from its first: a
 * document's opening heading is often a section with nothing under it.
 */
const snippetSections = 3;

/**
 * How much of each section a snippet is read from: its heading line and
 * the start of what it says, enough for a snippet once whitespace is
 * folded. A section can fill a whole document, and an answer can cite
 * many, so its whole text is never read for a few words of it.
 */
const snippetExcerptChars = citedSnippetMax * 8;

/**
 * What a section says under its heading: its text starts with its heading
 * line, but for text before a document's first heading, which has none.
 */
const underHeading = (text: string, headings: string): string => {
  if (headings === "[]") {
    return text;
  }
  const lineEnd = text.indexOf("\n");
  return lineEnd === -1 ? "" : text.slice(lineEnd + 1);
};

/**
 * How often a section's runs of spaces are halved while its text is
 * folded for a quote (`folded`): runs of up to 2^passes fold to one.
 */
const spaceFoldPasses = 5;

/**
 * A section's text as a quote is matched against it, in SQL: each line
 * break and tab a space, and runs of spaces one, as a quote's whitespace
 * is folded (`quoteOf` in chat-messages.ts). Done where the text is, as a
 * section can fill a whole document and is never read whole for a quote.
 */
const folded = (text: SQL | typeof sections.text): SQL => {
  let spaced = sql`replace(replace(replace(${text}, char(13), ' '), char(10), ' '), char(9), ' ')`;
  for (let pass = 0; pass < spaceFoldPasses; pass += 1) {
    spaced = sql`replace(${spaced}, '  ', ' ')`;
  }
  return spaced;
};

/**
 * Which of `links` quote words their note says now, by their place in
 * `links`: a quote matches within one section, whitespace aside.
 */
const quotedIn = async <C>(
  brain: Brain<C>,
  links: readonly NoteLink[]
): Promise<Set<number>> => {
  const quotes = links.flatMap(({ documentId, quote }, index) =>
    quote === null ? [] : [[index, documentId, quote]]
  );
  if (quotes.length === 0) {
    return new Set();
  }
  const found = await brain.db.all<{ link: number }>(sql`
    SELECT json_extract(quote.value, '$[0]') AS link
    FROM json_each(${JSON.stringify(quotes)}) AS quote
    WHERE EXISTS (
      SELECT 1 FROM ${sections}
      WHERE ${sections.documentId} = json_extract(quote.value, '$[1]')
        AND instr(${folded(sections.text)}, json_extract(quote.value, '$[2]')) > 0
    )
  `);
  return new Set(found.map(({ link }) => link));
};

/**
 * The documents `links` cite that `reader` may read, in the order the
 * links first name them: each as an answer that cites it shows it
 * (`ChatCitedDocument`), its snippet its description, or else what its
 * first sections say under their headings, as search holds them, with the
 * links to it as its spans, each quote kept only while it says it. Not
 * recorded: each was handed to the chat's code by a read that was
 * (`recordSources` in workspace.ts), and this names it, and the words of
 * it the answer quotes, to the person the answer is for, never to a
 * model. The access check is in the same query, so a document they can no
 * longer read, or one that is gone, is left out with its spans.
 */
export const cited = async <C>(
  brain: Brain<C>,
  reader: C,
  links: readonly NoteLink[]
): Promise<ChatCitedDocument[]> => {
  const documentIds = [...new Set(links.map(({ documentId }) => documentId))];
  if (documentIds.length === 0) {
    return [];
  }
  const allowed = await allowedFor(brain.ports, reader);
  const rows = await brain.db
    .select({
      documentId: documents.id,
      collectionId: documents.collectionId,
      title: documents.title,
      path: documents.path,
      description: documents.description,
      headings: sections.headings,
      text: sql<
        string | null
      >`substr(${sections.text}, 1, ${snippetExcerptChars})`,
    })
    .from(documents)
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    // A document's description is its snippet: its sections are read only
    // for one without.
    .leftJoin(
      sections,
      and(
        eq(sections.documentId, documents.id),
        lt(sections.position, snippetSections),
        eq(documents.description, "")
      )
    )
    .where(and(inList(documents.id, documentIds), allowed.documents()))
    .orderBy(asc(sections.position))
    .all();
  const quoted = await quotedIn(brain, links);
  const spansOf = (id: string): ChatCitedSpan[] =>
    links.flatMap(({ at, documentId, text, quote }, index) =>
      documentId === id
        ? [{ at, text, quote: quoted.has(index) ? quote : null }]
        : []
    );
  return documentIds.flatMap((id) => {
    const own = rows.filter(({ documentId }) => documentId === id);
    const [first] = own;
    if (first === undefined) {
      return [];
    }
    const { documentId, collectionId, title, path, description } = first;
    const said =
      own
        .map(({ text, headings }) =>
          text === null || headings === null
            ? ""
            : underHeading(text, headings).replaceAll(whitespace, " ").trim()
        )
        .find((under) => under !== "") ?? "";
    return [
      {
        documentId,
        collectionId,
        title,
        path,
        snippet: cut(
          description === ""
            ? said
            : description.replaceAll(whitespace, " ").trim(),
          citedSnippetMax
        ),
        spans: spansOf(id),
      },
    ];
  });
};
