import { and, desc, eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { outboxed } from "./audit.ts";
import { allowedFor } from "./authorize.ts";
import type { Brain } from "./brain.ts";
import { collections, documents, transcripts } from "./db/schema.ts";
import type { DetailValue } from "./events.ts";
import type { Json } from "./json.ts";
import type { Provenance } from "./knowledge.ts";

// A document's transcript: what was said, turn by turn, and the chapters
// it moved through. The Brain keeps it as any producer gives it (a speaker
// label, the words, and where in the recording when it has one), with no
// rule of its own about who speaks or what about: the host's producers
// fill it (core's: an uploaded WebVTT file), and the audience is the
// collection the producer saved it in.
//
// Threat model, and how each is closed:
//
// - A transcript read by someone who may not read its document: every
//   read puts the host's `authorize` answer inside its SQL
//   (`allowedOf(...).documents()`), collection access and `only` paths
//   alike, and is recorded through `onRead` with the documents it read.
// - Turns outliving the text they came with (an edit, a restore): a
//   transcript is written in the batch of its version and served only
//   while that version is current; any later save without one deletes it
//   (documents.ts `writeVersion`).
// - Turns outliving an erasure: one row per document, which a personal
//   purge deletes with its collection and a content purge rewrites with
//   the version's text (purge.ts). Turns have no search index of their
//   own (only the text saved with them is searched), so nothing else
//   holds them.
// - Speakers or words in the audit log: events carry counts and
//   identifiers only (`transcriptDetail`).
// - A flood: at most `transcriptMaxTurns` turns, `transcriptMaxChapters`
//   chapters and `transcriptMaxBytes` in all.

/** Most turns one transcript has. */
export const transcriptMaxTurns = 5000;

/** Most chapters one transcript has. */
export const transcriptMaxChapters = 500;

/** Most bytes of UTF-8 a transcript's turns and chapters take, as JSON. */
export const transcriptMaxBytes = 1024 * 1024;

/** Most characters of a speaker's label or a chapter's title. */
const labelMaxLength = 200;

/** Most characters of one turn. */
const turnMaxLength = 20_000;

/** Where in a recording, in milliseconds from its start. */
const offsetSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/** One turn: who spoke (a label; empty when the producer can't tell), and what. */
export const transcriptTurnSchema = z
  .strictObject({
    speaker: z.string().max(labelMaxLength),
    text: z.string().min(1).max(turnMaxLength),
    startMs: offsetSchema.optional(),
    endMs: offsetSchema.optional(),
  })
  .refine(
    ({ startMs, endMs }) =>
      endMs === undefined || (startMs !== undefined && startMs <= endMs),
    { message: "A turn's end needs its start, and comes after it" }
  );
export type TranscriptTurn = z.infer<typeof transcriptTurnSchema>;

/** A stretch of turns about one thing: its first and last turn, by index. */
export const transcriptChapterSchema = z
  .strictObject({
    title: z.string().min(1).max(labelMaxLength),
    firstTurn: z.int().min(0),
    lastTurn: z.int().min(0),
  })
  .refine(({ firstTurn, lastTurn }) => firstTurn <= lastTurn, {
    message: "A chapter's last turn comes after its first",
  });
export type TranscriptChapter = z.infer<typeof transcriptChapterSchema>;

/**
 * A transcript, as a producer gives it: its turns in order, and chapters
 * in order, each within the turns and after the one before.
 */
export const transcriptSchema = z
  .strictObject({
    turns: z.array(transcriptTurnSchema).min(1).max(transcriptMaxTurns),
    chapters: z.array(transcriptChapterSchema).max(transcriptMaxChapters),
  })
  .superRefine(({ turns, chapters }, context) => {
    let after = -1;
    for (const [index, { firstTurn, lastTurn }] of chapters.entries()) {
      if (firstTurn <= after || lastTurn >= turns.length) {
        context.addIssue({
          code: "custom",
          path: ["chapters", index],
          message:
            "A chapter starts after the one before and ends within the turns",
        });
      }
      after = lastTurn;
    }
  })
  .refine(
    (transcript) =>
      new TextEncoder().encode(JSON.stringify(transcript)).byteLength <=
      transcriptMaxBytes,
    { message: `A transcript takes at most ${transcriptMaxBytes} bytes` }
  );
export type Transcript = z.infer<typeof transcriptSchema>;

/** What a save's audit event says of the transcript it saved: counts only. */
export const transcriptDetail = (
  transcript: Transcript
): Record<string, DetailValue> => ({
  transcriptTurns: transcript.turns.length,
  transcriptChapters: transcript.chapters.length,
});

/**
 * A stored transcript's shape, without the limits a producer's is held
 * to: a purge's rewrite may have made a turn longer than a producer may
 * save, and it must still be read.
 */
const storedSchema = z.object({
  turns: z.array(
    z.object({
      speaker: z.string(),
      text: z.string(),
      startMs: z.number().optional(),
      endMs: z.number().optional(),
    })
  ),
  chapters: z.array(
    z.object({ title: z.string(), firstTurn: z.int(), lastTurn: z.int() })
  ),
});

/** The stored row's turns and chapters as a transcript. */
const fromRow = (row: { turns: string; chapters: string }): Transcript => {
  const turns: unknown = JSON.parse(row.turns);
  const chapters: unknown = JSON.parse(row.chapters);
  return storedSchema.parse({ turns, chapters });
};

/** Whether a document has a transcript stored now. */
export const hasTranscript = async (
  db: DrizzleD1Database,
  documentId: string
): Promise<boolean> =>
  (await db
    .select({ documentId: transcripts.documentId })
    .from(transcripts)
    .where(eq(transcripts.documentId, documentId))
    .get()) !== undefined;

/**
 * The statements that make version `version` of a document's transcript
 * `transcript`, in its save's batch: the one it had goes, and this one, if
 * any, takes its place. A save without one, of a document that `had` one
 * (`hasTranscript`, read before: the save's version check keeps any other
 * save from coming between), records `knowledge.transcript.removed`.
 */
export const transcriptWrites = <C>(
  brain: Brain<C>,
  actor: Json,
  {
    documentId,
    version,
    had,
  }: { documentId: string; version: number; had: boolean },
  transcript: Transcript | undefined,
  now: Date
): BatchItem<"sqlite">[] => {
  const { db } = brain;
  const removed = db
    .delete(transcripts)
    .where(eq(transcripts.documentId, documentId));
  if (transcript === undefined) {
    return had
      ? [
          removed,
          outboxed(brain, {
            actor,
            action: "knowledge.transcript.removed",
            target: { type: "document", id: documentId },
            detail: { version },
          }),
        ]
      : [removed];
  }
  return [
    removed,
    db.insert(transcripts).values({
      documentId,
      version,
      turns: JSON.stringify(transcript.turns),
      chapters: JSON.stringify(transcript.chapters),
      createdAt: now,
    }),
  ];
};

/**
 * The transcript stored for a document, whatever version it was saved
 * with, and that version: for a purge, which reaches every copy.
 */
export const storedTranscript = async (
  db: DrizzleD1Database,
  documentId: string
): Promise<{ version: number; transcript: Transcript } | undefined> => {
  const row = await db
    .select({
      version: transcripts.version,
      turns: transcripts.turns,
      chapters: transcripts.chapters,
    })
    .from(transcripts)
    .where(eq(transcripts.documentId, documentId))
    .get();
  return row === undefined
    ? undefined
    : { version: row.version, transcript: fromRow(row) };
};

/** Every text a transcript holds: its speakers, words and chapter titles. */
export const transcriptTexts = ({ turns, chapters }: Transcript): string[] => [
  ...turns.flatMap(({ speaker, text }) => [speaker, text]),
  ...chapters.map(({ title }) => title),
];

/** `transcript` with `rewrite` applied to every text it holds. */
export const rewrittenTranscript = (
  { turns, chapters }: Transcript,
  rewrite: (text: string) => string
): Transcript => ({
  turns: turns.map((turn) => ({
    ...turn,
    speaker: rewrite(turn.speaker),
    text: rewrite(turn.text),
  })),
  chapters: chapters.map((chapter) => ({
    ...chapter,
    title: rewrite(chapter.title),
  })),
});

/**
 * Replaces a document's transcript where it stands, at the version it was
 * read at: a content purge's rewrite when no version's text changed but
 * the transcript did. A save in between replaced it, and its transcript
 * is left to a purge run again (counted in its `stillFound`).
 */
export const replaceTranscript = (
  db: DrizzleD1Database,
  documentId: string,
  version: number,
  transcript: Transcript
) =>
  db
    .update(transcripts)
    .set({
      turns: JSON.stringify(transcript.turns),
      chapters: JSON.stringify(transcript.chapters),
    })
    .where(
      and(
        eq(transcripts.documentId, documentId),
        eq(transcripts.version, version)
      )
    );

/** A document with a transcript, as a listing gives it: never its turns. */
export interface TranscriptSummary {
  documentId: string;
  collectionId: string;
  path: string;
  title: string;
  version: number;
  savedAt: Date;
  /** How many turns and chapters it has. */
  turns: number;
  chapters: number;
}

/** A transcript as a reader gets it: its document, and its turns and chapters. */
export interface ReadTranscript extends Omit<
  TranscriptSummary,
  "turns" | "chapters"
> {
  transcript: Transcript;
}

/** Most documents one listing names. */
export const transcriptsMaxListed = 50;

const listOptionsSchema = z
  .strictObject({
    limit: z
      .int()
      .min(1)
      .max(transcriptsMaxListed)
      .default(transcriptsMaxListed),
  })
  .default({ limit: transcriptsMaxListed });

/**
 * The documents `reader` may read now (the host's `authorize`, inside the
 * query) whose current version has a transcript, newest saved first, at
 * most `limit`: each with how many turns and chapters it has, counted in
 * the query, so no turn is loaded. Recorded through `onRead` with the
 * documents named, when there is any.
 */
export const listTranscripts = async <C>(
  brain: Brain<C>,
  reader: C,
  options?: { limit?: number }
): Promise<{ transcripts: TranscriptSummary[]; provenance?: Provenance }> => {
  const { limit } = listOptionsSchema.parse(options);
  const { db } = brain;
  const allowed = await allowedFor(brain.ports, reader);
  const rows = await db
    .select({
      documentId: documents.id,
      path: documents.path,
      title: documents.title,
      version: transcripts.version,
      savedAt: transcripts.createdAt,
      turns: sql<number>`json_array_length(${transcripts.turns})`,
      chapters: sql<number>`json_array_length(${transcripts.chapters})`,
      collection: {
        id: collections.id,
        sensitive: collections.sensitive,
      },
    })
    .from(transcripts)
    .innerJoin(
      documents,
      and(
        eq(documents.id, transcripts.documentId),
        eq(documents.currentVersion, transcripts.version)
      )
    )
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .where(allowed.documents())
    .orderBy(desc(transcripts.createdAt), desc(transcripts.documentId))
    .limit(limit);
  if (rows.length === 0) {
    return { transcripts: [] };
  }
  const sources = new Map(
    rows.map(({ collection }) => [collection.id, collection])
  );
  const provenance = await brain.ports.onRead(
    reader,
    {
      action: "knowledge.read",
      documentIds: rows.map(({ documentId }) => documentId),
      detail: { read: "transcripts", count: rows.length },
    },
    ...sources.values()
  );
  return {
    transcripts: rows.map(({ collection, ...row }) => ({
      ...row,
      collectionId: collection.id,
    })),
    provenance,
  };
};

/**
 * The transcript of `documentId`'s current version, if `reader` may read
 * the document now (the host's `authorize`, inside the query) and it has
 * one: undefined alike when it has none and when they may not read it.
 * Recorded through `onRead` when read.
 */
export const readTranscript = async <C>(
  brain: Brain<C>,
  reader: C,
  documentId: string
): Promise<{ read: ReadTranscript; provenance: Provenance } | undefined> => {
  const { db } = brain;
  const allowed = await allowedFor(brain.ports, reader);
  const row = await db
    .select({
      documentId: documents.id,
      path: documents.path,
      title: documents.title,
      version: transcripts.version,
      savedAt: transcripts.createdAt,
      turns: transcripts.turns,
      chapters: transcripts.chapters,
      collection: {
        id: collections.id,
        sensitive: collections.sensitive,
      },
    })
    .from(transcripts)
    .innerJoin(
      documents,
      and(
        eq(documents.id, transcripts.documentId),
        eq(documents.currentVersion, transcripts.version)
      )
    )
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .where(and(eq(transcripts.documentId, documentId), allowed.documents()))
    .get();
  if (row === undefined) {
    return undefined;
  }
  const provenance = await brain.ports.onRead(
    reader,
    {
      action: "knowledge.read",
      target: { type: "document", id: row.documentId },
      detail: { read: "transcript", version: row.version },
    },
    row.collection
  );
  return {
    read: {
      documentId: row.documentId,
      collectionId: row.collection.id,
      path: row.path,
      title: row.title,
      version: row.version,
      savedAt: row.savedAt,
      transcript: fromRow(row),
    },
    provenance,
  };
};
