import { z } from "zod";

// A transcript as a producer gives it: what was said, turn by turn, and
// the chapters it moved through, each turn with a speaker label, the
// words, and where in the recording when it has one. Core's file
// extractor makes one from an uploaded WebVTT file; today's Brain keeps
// it with the document's version (packages/brain, transcripts.ts).
//
// A flood is held off here: at most `transcriptMaxTurns` turns,
// `transcriptMaxChapters` chapters and `transcriptMaxBytes` in all.

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
