import { z } from "zod";

// A transcript as a producer gives it: what was said, turn by turn, and
// the chapters it moved through, each turn with a speaker label, the
// words, and where in the recording when it has one. Core's file
// extractor makes one from an uploaded WebVTT file.
//
// Named for its role (`TranscriptInput`): `@grasp-os/shared/brain` has the
// `Transcript` a page reads. Today's Brain package keeps its own copy of
// this schema for its documents until the cutover deletes the package: it
// can't import this one, since shared depends on it.
//
// A flood is held off here: at most `transcriptMaxTurns` turns,
// `transcriptMaxChapters` chapters and `transcriptMaxBytes` in all.

/** Most turns one transcript has. */
const transcriptMaxTurns = 5000;

/** Most chapters one transcript has. */
const transcriptMaxChapters = 500;

/** Most bytes of UTF-8 a transcript's turns and chapters take, as JSON. */
const transcriptMaxBytes = 1024 * 1024;

/** Most characters of a speaker's label or a chapter's title. */
const labelMaxLength = 200;

/** Most characters of one turn. */
const turnMaxLength = 20_000;

/** Where in a recording, in milliseconds from its start. */
const offsetSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/** One turn: who spoke (a label; empty when the producer can't tell), and what. */
const transcriptTurnSchema = z
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

/** A stretch of turns about one thing: its first and last turn, by index. */
const transcriptChapterSchema = z
  .strictObject({
    title: z.string().min(1).max(labelMaxLength),
    firstTurn: z.int().min(0),
    lastTurn: z.int().min(0),
  })
  .refine(({ firstTurn, lastTurn }) => firstTurn <= lastTurn, {
    message: "A chapter's last turn comes after its first",
  });

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
export type TranscriptInput = z.infer<typeof transcriptSchema>;
