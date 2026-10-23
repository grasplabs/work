import { allowedFor } from "@grasp-os/brain/authorize";
import type { Brain } from "@grasp-os/brain/brain";
import { collections, documents, sections } from "@grasp-os/brain/schema";
import { citedSnippetMax } from "@grasp-os/shared/chat";
import type { ChatCitedDocument } from "@grasp-os/shared/chat";
import { and, asc, eq, lt, sql } from "drizzle-orm";

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
 * The documents of `documentIds` that `reader` may read, in that order:
 * each as an answer that cites it shows it (`ChatCitedDocument`), its
 * snippet its description, or else what its first sections say under
 * their headings, as search holds them. Not recorded: each was handed to
 * the chat's code by a read that was (`recordSources` in workspace.ts),
 * and this names it to the person the answer is for, never to a model.
 * The access check is in the same query, so a document they can no longer
 * read, or one that is gone, is left out.
 */
export const cited = async <C>(
  brain: Brain<C>,
  reader: C,
  documentIds: readonly string[]
): Promise<ChatCitedDocument[]> => {
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
      },
    ];
  });
};
