import { brainErrors, brainNotesOptionsSchema } from "@grasp-os/shared/brain";
import type { BrainNote, BrainNotePage } from "@grasp-os/shared/brain";
import { collectionIdSchema, documentIdSchema } from "@grasp-os/shared/ids";
import { documentTypeOf } from "@grasp-os/shared/knowledge";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { alias } from "drizzle-orm/sqlite-core";

import { collections, documents, links } from "./db/knowledge/schema.ts";
import { noteProvenance } from "./knowledge/access.ts";
import { allowedFor } from "./knowledge/app-entries.ts";

// Every note in the brain with its links (`brain.notes`), a page at a
// time, as the person may read them: what core records today, Knowledge
// documents and their links. Goals, questions and workflow suggestions
// join as other kinds once core keeps them (GRA-527).
//
// From the threat model (GRA-530), each way the read could show more than
// the reads it is built from, and what closes it:
//
// - A note outside the person's access: the documents are read through
//   `allowedFor`'s condition inside the query, the one every Knowledge
//   read uses (knowledge/access.ts), never filtered after.
// - A link showing a document the person can't read: its target is
//   resolved to an ID through the same condition, so an App's entry the
//   person can't open stays unresolved. The path it names is in the
//   note's own text, which they may read.
// - Hidden notes inferred from paging: a page and where the next starts
//   are made from what the person may read alone. The cursor is a
//   document ID the server parses, never a filter: malformed cursors are
//   refused.
// - Content: a note says what a listing says of a document, never its
//   text; a link, its path and label, which its note's text holds.
// - A read the audit log can't hold: a page's notes and their collections
//   fit in its event's provenance (`brainNotesMaxLimit`). Each note has at
//   most `documentMaxLinks` links, as its save holds it to.

/** The documents a note links to, as the read resolves them. */
const target = alias(documents, "target");

/** A page of `person`'s notes, in ID order, after `options.cursor`. */
export const brainNotes = async (
  env: Env,
  person: Identity,
  options: unknown
): Promise<BrainNotePage> => {
  const { cursor, limit } = brainErrors.parse(
    "brain.invalid",
    brainNotesOptionsSchema,
    options
  );
  const reader = { type: "person", person } as const;
  const db = drizzle(env.KNOWLEDGE);
  const allowed = await allowedFor(env, db, reader);
  // One more than a page: whether another follows.
  const rows = await db
    .select({
      id: documents.id,
      collectionId: documents.collectionId,
      path: documents.path,
      title: documents.title,
      type: documents.type,
      updatedAt: documents.updatedAt,
      sensitive: collections.sensitive,
    })
    .from(documents)
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .where(
      and(
        allowed.documents(),
        cursor === undefined ? undefined : gt(documents.id, cursor)
      )
    )
    .orderBy(asc(documents.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const ids = page.map(({ id }) => id);
  const linked =
    ids.length === 0
      ? []
      : await db
          .select({
            from: links.fromDocumentId,
            path: links.toPath,
            label: links.label,
            documentId: target.id,
          })
          .from(links)
          .innerJoin(documents, eq(documents.id, links.fromDocumentId))
          .innerJoin(collections, eq(collections.id, documents.collectionId))
          .leftJoin(
            target,
            and(
              // Links name paths in their own note's collection.
              eq(target.collectionId, documents.collectionId),
              eq(links.toCollectionId, documents.collectionId),
              eq(target.path, links.toPath),
              allowed.documents(target.path)
            )
          )
          .where(inArray(links.fromDocumentId, ids))
          .orderBy(asc(links.fromDocumentId), asc(links.toPath));
  const notes = page.map((row): BrainNote => ({
    kind: "document",
    id: documentIdSchema.parse(row.id),
    collectionId: collectionIdSchema.parse(row.collectionId),
    path: row.path,
    title: row.title,
    type: documentTypeOf(row.type),
    updatedAt: row.updatedAt.toISOString(),
    links: linked
      .filter(({ from }) => from === row.id)
      .map(({ path, label, documentId }) => ({
        path,
        label,
        documentId:
          documentId === null ? null : documentIdSchema.parse(documentId),
      })),
  }));
  await noteProvenance(
    env,
    reader,
    {
      action: "knowledge.read",
      documentIds: ids,
      detail: { read: "notes", count: ids.length },
    },
    ...page.map((row) => ({ id: row.collectionId, sensitive: row.sensitive }))
  );
  const last = page.at(-1);
  return {
    notes,
    next: rows.length > limit && last !== undefined ? last.id : null,
  };
};
