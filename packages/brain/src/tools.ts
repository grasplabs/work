import { and, asc, eq, gte, lt, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { allowedFor } from "./authorize.ts";
import type { Brain } from "./brain.ts";
import { collections, documents, links, sections } from "./db/schema.ts";
import {
  documentTypeOf,
  followMaxEntries,
  collectionErrors,
  readOptionsSchema,
} from "./documents-contract.ts";
import type {
  DocumentLink,
  FollowResult,
  BrainRead,
  SkillFile,
} from "./documents-contract.ts";
import {
  backlinkRows,
  documentMaxLinks,
  getDocument,
  readableDocument,
  toSummary,
} from "./documents.ts";
import { documentIdSchema } from "./ids.ts";

// The agent's Brain tools (Code Mode: a typed API it filters in code):
// a small catalog always in its context (core's catalog.ts), then search
// (search.ts), read and follow on demand. They read through the same access check as every other
// read (`allowedFor`), and every read but the catalog goes through
// `noteProvenance`: marked with where it came from, restricting an App or
// agent's context when it is sensitive, and recorded in the audit log.

const headingsSchema = z.array(z.string());

/**
 * One section of a document (a search hit's `section`), without the rest
 * of it, or the whole document, at its current version.
 */
export const read = async <C>(
  brain: Brain<C>,
  reader: C,
  documentId: unknown,
  options?: unknown
): Promise<BrainRead> => {
  const { section } = collectionErrors.parse(
    "brain.document_invalid",
    readOptionsSchema,
    options
  );
  if (section === undefined) {
    const { version, provenance, ...summary } = await getDocument(
      brain,
      reader,
      documentId
    );
    return { ...summary, section: null, text: version.text, provenance };
  }
  const { db } = brain;
  const allowed = await allowedFor(brain.ports, reader);
  const id = documentIdSchema.safeParse(documentId);
  // The section is read in the same query as the access check, as a whole
  // document is (`getDocument`).
  const found = id.success
    ? await db
        .select({
          document: documents,
          collection: collections,
          section: {
            version: sections.version,
            headings: sections.headings,
            text: sections.text,
          },
        })
        .from(documents)
        .innerJoin(collections, eq(collections.id, documents.collectionId))
        .leftJoin(
          sections,
          and(
            eq(sections.documentId, documents.id),
            eq(sections.position, section)
          )
        )
        .where(and(eq(documents.id, id.data), allowed.documents()))
        .get()
    : undefined;
  if (!found) {
    throw collectionErrors.create("brain.document_not_found");
  }
  const { document, collection, section: row } = found;
  // Recorded before a missing section is refused, as a missing version is:
  // how many sections a document has says something of it too.
  const provenance = await brain.ports.onRead(
    reader,
    {
      action: "brain.read",
      target: { type: "document", id: document.id },
      detail: {
        read: "section",
        version: row?.version ?? document.currentVersion,
        section,
      },
    },
    collection
  );
  if (row === null) {
    throw collectionErrors.create("brain.document_not_found");
  }
  return {
    ...toSummary(document),
    section: {
      position: section,
      version: row.version,
      headings: headingsSchema.parse(JSON.parse(row.headings)),
    },
    text: row.text,
    provenance,
  };
};

const target = alias(documents, "target");

/**
 * The first path after every path in the folder `folder` (which ends in
 * `/`): its `/` raised to `0`, the next character. SQLite compares text by
 * its bytes, so the folder's paths are those from `folder` up to this one.
 */
const pastFolder = (folder: string): string => `${folder.slice(0, -1)}0`;

/**
 * Where a document leads: the documents its links name, the documents
 * that link to it, and, for a skill, the documents in its folder and
 * below, which it refers to by relative path (a skill at the top of its
 * collection has the whole collection as its folder). All of them are in
 * the document's own collection, so its provenance is that collection's.
 */
export const follow = async <C>(
  brain: Brain<C>,
  reader: C,
  documentId: unknown
): Promise<FollowResult> => {
  const { db } = brain;
  const allowed = await allowedFor(brain.ports, reader);
  const { document, collection } = await readableDocument(
    db,
    allowed,
    documentId
  );
  const linkRows = await db
    .select({
      path: links.toPath,
      label: links.label,
      documentId: target.id,
      title: target.title,
    })
    .from(links)
    // The document's own collection, which is readable: for which of its
    // documents the reader may read (the Apps collection's, app-entries.ts).
    .innerJoin(collections, eq(collections.id, links.toCollectionId))
    .leftJoin(
      target,
      and(
        eq(target.collectionId, links.toCollectionId),
        eq(target.path, links.toPath),
        allowed.documents(target.path)
      )
    )
    .where(
      and(
        eq(links.fromDocumentId, document.id),
        // Links name paths in their own collection, which is readable.
        eq(links.toCollectionId, document.collectionId)
      )
    )
    .orderBy(asc(links.toPath))
    // All of them: a save keeps a document to this many.
    .limit(documentMaxLinks);
  const linked: DocumentLink[] = linkRows.map((row) => ({
    ...row,
    documentId:
      row.documentId === null ? null : documentIdSchema.parse(row.documentId),
  }));
  // One more than it returns of each, to tell whether there are more.
  const linking = await backlinkRows(db, allowed, document, {
    limit: followMaxEntries + 1,
  });
  const backlinks = linking.slice(0, followMaxEntries);
  let truncated = linking.length > followMaxEntries;
  let files: SkillFile[] = [];
  if (document.type === "skill") {
    const folder = document.path.slice(0, document.path.lastIndexOf("/") + 1);
    const fileRows = await db
      .select({ document: documents })
      .from(documents)
      .innerJoin(collections, eq(collections.id, documents.collectionId))
      .where(
        and(
          eq(documents.collectionId, document.collectionId),
          ne(documents.id, document.id),
          folder === ""
            ? undefined
            : and(
                gte(documents.path, folder),
                lt(documents.path, pastFolder(folder))
              ),
          allowed.documents()
        )
      )
      .orderBy(asc(documents.path))
      .limit(followMaxEntries + 1);
    truncated ||= fileRows.length > followMaxEntries;
    files = fileRows.slice(0, followMaxEntries).map(({ document: row }) => ({
      documentId: documentIdSchema.parse(row.id),
      path: row.path,
      title: row.title,
      type: documentTypeOf(row.type),
      description: row.description,
    }));
  }
  const provenance = await brain.ports.onRead(
    reader,
    {
      action: "brain.read",
      target: { type: "document", id: document.id },
      detail: {
        read: "follow",
        links: linked.length,
        backlinks: backlinks.length,
        files: files.length,
      },
    },
    collection
  );
  return { links: linked, backlinks, files, truncated, provenance };
};
