import {
  brainChangesMaxAgeMs,
  brainChangesOptionsSchema,
  brainErrors,
} from "@grasp-os/shared/brain";
import type { BrainChange, BrainChangePage } from "@grasp-os/shared/brain";
import { collectionIdSchema, documentIdSchema } from "@grasp-os/shared/ids";
import { documentTypeOf } from "@grasp-os/shared/knowledge";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, desc, eq, gt, lt, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { collections, documents } from "./db/knowledge/schema.ts";
import { noteProvenance } from "./knowledge/access.ts";
import { allowedFor } from "./knowledge/app-entries.ts";

// What changed in the brain since a moment (`brain.changes`): one feed of
// what core records today, newest first, a page at a time, as the person
// may read it. A change is a `kind`: Knowledge documents added or changed,
// and, for admins, the onboarding's sources, as `brain.read` shows them
// (brain-rpc.ts). Goals, questions and workflow suggestions join the union
// once core keeps them (GRA-527); nothing is made up for them here.
//
// From the threat model (GRA-521), each way the feed could show more than
// the reads it is built from, and what closes it:
//
// - A document outside the person's access, or its title: the documents
//   are read through `allowedFor`'s condition inside the query, the one
//   every Knowledge read uses (knowledge/access.ts), never filtered after.
// - The onboarding through the feed: its sources come only for an admin,
//   decided as `brain.read` decides it (brain-rpc.ts, `onboardingFacts`).
// - Hidden changes inferred from paging: a page, its size and where the
//   next starts are made from what the person may read alone. The cursor
//   is a position the server parses, never a filter: malformed cursors
//   are refused, and any other only moves through the person's own rows,
//   never before `since`.
// - Content: a change says what a listing says of a document (its path,
//   title and type), never its text; and of a source, its title.
// - Unbounded reads: at most `brainChangesMaxLimit` a page, in the order
//   of `documents_updated_at_idx`, and never further back than
//   `brainChangesMaxAgeMs`.
// - A read the audit log can't hold: a page's documents and their
//   collections fit in its event's provenance (`brainChangesMaxLimit`).
//
// The read is audited as any Knowledge read is (`noteProvenance`): one
// `knowledge.read`, with the collections and documents it names. Deleted
// documents leave no row, so the feed doesn't show them.

/** An onboarding source, as a change: its ID and title as `brain.read` names it, and when. */
export interface SourceChange {
  id: string;
  title: string;
  /** ISO 8601. */
  at: string;
}

/** A change's place in the feed: newest first, then by kind and ID, descending. */
interface Position {
  at: number;
  kind: BrainChange["kind"];
  id: string;
}

/** The latest moment a `Date` holds, in ms since the epoch. */
const maxDateMs = 8_640_000_000_000_000;

const positionSchema = z.tuple([
  z.int().nonnegative().max(maxDateMs),
  z.enum(["document", "source"]),
  z.string().min(1).max(256),
]);

/** A position as the opaque cursor a page hands back. */
const cursorOf = ({ at, kind, id }: Position): string =>
  btoa(JSON.stringify([at, kind, id]));

/** The position `cursor` names; `brain.invalid` for one core didn't make. */
const positionOf = (cursor: string): Position => {
  try {
    const [at, kind, id] = brainErrors.parse(
      "brain.invalid",
      positionSchema,
      JSON.parse(atob(cursor))
    );
    return { at, kind, id };
  } catch (error) {
    if (brainErrors.codeOf(error) !== undefined) {
      throw error;
    }
    throw brainErrors.create("brain.invalid");
  }
};

/** Whether `one` comes after `other` in the feed: older, or after it at the same moment. */
const isAfter = (one: Position, other: Position): boolean => {
  if (one.at !== other.at) {
    return one.at < other.at;
  }
  if (one.kind !== other.kind) {
    return one.kind < other.kind;
  }
  return one.id < other.id;
};

/** The documents after `cursor` in the feed, as SQL on `documents`. */
const documentsAfter = (cursor: Position | undefined): SQL | undefined => {
  if (cursor === undefined) {
    return undefined;
  }
  const at = new Date(cursor.at);
  const atTheSameMoment =
    cursor.kind > "document"
      ? eq(documents.updatedAt, at)
      : and(eq(documents.updatedAt, at), lt(documents.id, cursor.id));
  return cursor.kind < "document"
    ? lt(documents.updatedAt, at)
    : or(lt(documents.updatedAt, at), atTheSameMoment);
};

/** A change with its place in the feed. */
interface Placed {
  position: Position;
  change: BrainChange;
}

/**
 * The person's changes in the brain since `options.since`, newest first, a
 * page at a time: the Knowledge documents they may read added or changed,
 * and `sources` (the onboarding's, which only an admin is given).
 */
export const brainChanges = async (
  env: Env,
  person: Identity,
  options: unknown,
  sources: readonly SourceChange[]
): Promise<BrainChangePage> => {
  const { since, cursor, limit } = brainErrors.parse(
    "brain.invalid",
    brainChangesOptionsSchema,
    options
  );
  // No further back than the feed goes.
  const sinceAt = new Date(
    Math.max(Date.parse(since), Date.now() - brainChangesMaxAgeMs)
  );
  const after = cursor === undefined ? undefined : positionOf(cursor);
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
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
      sensitive: collections.sensitive,
    })
    .from(documents)
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .where(
      and(
        allowed.documents(),
        gt(documents.updatedAt, sinceAt),
        documentsAfter(after)
      )
    )
    .orderBy(desc(documents.updatedAt), desc(documents.id))
    .limit(limit + 1);
  const placed: Placed[] = [
    ...rows.map((row): Placed => ({
      position: { at: row.updatedAt.getTime(), kind: "document", id: row.id },
      change: {
        kind: "document",
        at: row.updatedAt.toISOString(),
        change: row.createdAt > sinceAt ? "added" : "changed",
        document: {
          id: documentIdSchema.parse(row.id),
          collectionId: collectionIdSchema.parse(row.collectionId),
          path: row.path,
          title: row.title,
          type: documentTypeOf(row.type),
        },
      },
    })),
    ...sources.flatMap((source): Placed[] => {
      const position: Position = {
        at: Date.parse(source.at),
        kind: "source",
        id: source.id,
      };
      return position.at > sinceAt.getTime() &&
        (after === undefined || isAfter(position, after))
        ? [
            {
              position,
              change: {
                kind: "source",
                at: new Date(position.at).toISOString(),
                source: { id: source.id, title: source.title },
              },
            },
          ]
        : [];
    }),
  ].toSorted((one, other) => (isAfter(one.position, other.position) ? 1 : -1));
  const page = placed.slice(0, limit);
  const last = page.at(-1);
  const shown = rows.filter(({ id }) =>
    page.some(
      ({ change }) => change.kind === "document" && change.document.id === id
    )
  );
  await noteProvenance(
    env,
    reader,
    {
      action: "knowledge.read",
      documentIds: shown.map(({ id }) => id),
      detail: { read: "changes", count: shown.length },
    },
    ...shown.map((row) => ({ id: row.collectionId, sensitive: row.sensitive }))
  );
  return {
    changes: page.map(({ change }) => change),
    next:
      placed.length > limit && last !== undefined
        ? cursorOf(last.position)
        : null,
  };
};
