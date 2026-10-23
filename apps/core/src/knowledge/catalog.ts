import { allowedFor } from "@grasp-os/brain/authorize";
import type { Brain } from "@grasp-os/brain/brain";
import { collectionIdSchema, documentIdSchema } from "@grasp-os/brain/ids";
import type { Provenance } from "@grasp-os/brain/knowledge";
import { collections, documents } from "@grasp-os/brain/schema";
import type {
  CatalogCollection,
  CatalogSkill,
  KnowledgeCatalog,
} from "@grasp-os/shared/knowledge";
import { and, asc, eq } from "drizzle-orm";

import { inList } from "../db/d1.ts";

// The agent's catalog of Knowledge: the collections it may read and the
// skills in them, always in its context within a fixed size, and noting
// the skills a turn lists as a read. Skills are core's convention over
// Knowledge's documents (the `skill` type), so the catalog is core's.

/**
 * The catalog is in an agent's context on every turn, so it has a fixed
 * budget: 16,000 characters of its JSON, about 4,000 tokens at the usual
 * 4 characters per token. Every description is cut to
 * {@link catalogDescriptionMaxLength} characters, so no one entry takes the
 * budget; collections come first, as the agent's way in, then skills, each
 * by name, until the next entry doesn't fit. What is left out is still
 * found by search, and `truncated` says so.
 */
export const catalogMaxCharacters = 16_000;

const catalogDescriptionMaxLength = 200;

/**
 * Most collections, and most skills, the catalog reads: more than its
 * budget holds, so a large library costs no more than the entries that fit.
 */
const catalogMaxEntries = 200;

/**
 * `text` cut to `max` characters, marked when cut. By code points, so a cut
 * never leaves half a surrogate pair; one through an emoji sequence only
 * shortens the emoji.
 */
export const cut = (text: string, max: number): string => {
  // oxlint-disable-next-line typescript/no-misused-spread -- see above
  const characters = [...text];
  return characters.length <= max
    ? text
    : `${characters.slice(0, max - 1).join("")}…`;
};

/**
 * The first of `entries` that fit in `budget` characters of JSON (each
 * with a comma), the characters left, and whether all of them fit.
 */
const fitting = <Entry>(
  entries: Entry[],
  budget: number
): { fits: Entry[]; left: number; all: boolean } => {
  const fits: Entry[] = [];
  let left = budget;
  for (const entry of entries) {
    const size = JSON.stringify(entry).length + 1;
    if (size > left) {
      return { fits, left, all: false };
    }
    fits.push(entry);
    left -= size;
  }
  return { fits, left, all: true };
};

/**
 * The collections `reader` may read, and the skills in them, within
 * {@link catalogMaxCharacters}. Only skills of collections that aren't
 * sensitive: the catalog reaches the agent's context without a read, so it
 * holds nothing that would have to put it in restricted mode. A sensitive
 * collection's skills are found by search, which does. Nor is it recorded:
 * it names what may be read, and reading any of it is recorded.
 */
export const catalog = async <C>(
  brain: Brain<C>,
  reader: C
): Promise<KnowledgeCatalog> => {
  const { db } = brain;
  const allowed = await allowedFor(brain.ports, reader);
  const collectionRows = await db
    .select({
      id: collections.id,
      name: collections.name,
      description: collections.description,
      sensitive: collections.sensitive,
    })
    .from(collections)
    .where(allowed.collections)
    .orderBy(asc(collections.name), asc(collections.id))
    .limit(catalogMaxEntries + 1);
  const skillRows = await db
    .select({
      documentId: documents.id,
      collectionId: documents.collectionId,
      name: documents.title,
      description: documents.description,
    })
    .from(documents)
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .where(
      and(
        eq(documents.type, "skill"),
        eq(collections.sensitive, false),
        allowed.documents()
      )
    )
    .orderBy(asc(documents.title), asc(documents.id))
    .limit(catalogMaxEntries + 1);
  const listed: CatalogCollection[] = collectionRows
    .slice(0, catalogMaxEntries)
    .map((row) => ({
      id: collectionIdSchema.parse(row.id),
      name: row.name,
      description: cut(row.description, catalogDescriptionMaxLength),
      sensitive: row.sensitive,
    }));
  const skills: CatalogSkill[] = skillRows
    .slice(0, catalogMaxEntries)
    .map((row) => ({
      documentId: documentIdSchema.parse(row.documentId),
      collectionId: collectionIdSchema.parse(row.collectionId),
      name: row.name,
      description: cut(row.description, catalogDescriptionMaxLength),
    }));
  const envelope = JSON.stringify({
    collections: [],
    skills: [],
    truncated: false,
  }).length;
  const first = fitting(listed, catalogMaxCharacters - envelope);
  const then = fitting(skills, first.left);
  return {
    collections: first.fits,
    skills: then.fits,
    truncated:
      !(first.all && then.all) ||
      collectionRows.length > catalogMaxEntries ||
      skillRows.length > catalogMaxEntries,
  };
};

/**
 * Notes the skills a turn lists in an agent's prompt (names and
 * descriptions, from `catalog`) as a read of the collections they are
 * in, as any Knowledge read is (`noteProvenance`): recorded in the audit
 * log with the skills as its provenance, and restricting the context
 * first if any of them were sensitive. Returns the collections, only
 * those that listed a skill, for the context to carry as sources.
 */
export const noteListedSkills = async <C>(
  brain: Brain<C>,
  reader: C,
  skills: readonly CatalogSkill[]
): Promise<Provenance> => {
  const ids = [...new Set(skills.map(({ collectionId }) => collectionId))];
  if (ids.length === 0) {
    return { collectionIds: [], sensitive: false, restricted: false };
  }
  const sources = await brain.db
    .select({ id: collections.id, sensitive: collections.sensitive })
    .from(collections)
    .where(inList(collections.id, ids));
  return await brain.ports.onRead(
    reader,
    {
      action: "knowledge.read",
      documentIds: skills.map(({ documentId }) => documentId),
      detail: { read: "skills", skills: skills.length },
    },
    ...sources
  );
};
