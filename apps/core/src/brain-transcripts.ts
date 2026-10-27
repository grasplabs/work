import { listTranscripts, readTranscript } from "@grasp-os/brain/transcripts";
import type { Transcript as StoredTranscript } from "@grasp-os/brain/transcripts";
import {
  brainErrors,
  brainTranscriptSourcesMax,
  sourceIdSchema,
} from "@grasp-os/shared/brain";
import type { Source, Transcript } from "@grasp-os/shared/brain";
import { documentIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";

import { brainOf } from "./brain/ports.ts";

// The brain's sources' transcripts: `brain.readWorkspace` (brain-rpc.ts) says only
// which sources have one, and how many turns (`Source.transcriptTurns`);
// `brain.transcript` reads one source's turns and chapters when it is
// opened, authorized and audited as that one read, so a page load never
// carries every transcript. One producer, and nothing else: a Brain
// document saved with a transcript (an uploaded WebVTT file,
// brain/uploads.ts), listed and read through the Brain
// (`listTranscripts`, `readTranscript`), so only from documents the person
// may read at that moment, as the `authorize` port says, and each
// recorded as a Brain read. Each is a source of its own.
//
// A team's interviews never have a transcript here, for anyone (Nick,
// GRA-529): members and admins may see only what five or more people
// said, put together, and Grasp's staff only numbers. Nothing core holds
// is that yet (the brain's statements are each one person's approved
// words, names taken out), so an interview source shows no turns and no
// count of them: its source says only how many people it rests on (that
// aggregated view is GRA-1084, under GRA-330). Raw
// lines, approved statements, the kickoff's transcript and a team lead's
// interview never become turns.

/** What a Brain document's source id starts with. */
const brainSourcePrefix = "src.brain-";

/** A Brain document's source, as the brain names it. */
export const brainSourceId = (documentId: string): string =>
  `${brainSourcePrefix}${documentId}`;

const msPerSecond = 1000;
const secondsPerMinute = 60;

/** Where in a recording, as the brain writes a minute: `m:ss`. */
const minuteOf = (ms: number): string => {
  const seconds = Math.floor(ms / msPerSecond);
  return `${Math.floor(seconds / secondsPerMinute)}:${String(
    seconds % secondsPerMinute
  ).padStart(2, "0")}`;
};

/**
 * A stored transcript as the brain shows one: by the minute when every
 * turn has its time, else by passage (its turn's number, from 1); a
 * chapter starts where its first turn does.
 */
export const shownTranscript = ({
  turns,
  chapters,
}: StoredTranscript): Transcript => {
  const starts = turns.map(({ startMs }) => startMs);
  const timed = starts.every((start) => start !== undefined);
  const atOf = (index: number): string => {
    const start = starts[index];
    return timed && start !== undefined ? minuteOf(start) : String(index + 1);
  };
  return {
    unit: timed ? "minute" : "passage",
    turns: turns.map(({ speaker, text }, index) => ({
      at: atOf(index),
      speaker,
      text,
    })),
    chapters: chapters.map(({ title, firstTurn }) => ({
      title,
      at: atOf(firstTurn),
    })),
  };
};

/** The day of a moment: `YYYY-MM-DD`. */
const dayOf = (moment: Date): string => moment.toISOString().slice(0, 10);

/**
 * The Brain documents with a transcript `person` may read now, newest
 * saved first, at most `brainTranscriptSourcesMax`, each as a source with
 * how many turns it has: never the turns.
 */
export const brainTranscriptSources = async (
  env: Env,
  person: Identity
): Promise<Source[]> => {
  const { transcripts } = await listTranscripts(
    brainOf(env),
    { type: "person", person },
    { limit: brainTranscriptSourcesMax }
  );
  return transcripts.map(({ documentId, title, savedAt, turns }) => ({
    id: brainSourceId(documentId),
    kind: "document",
    title,
    date: dayOf(savedAt),
    transcriptTurns: turns,
  }));
};

/**
 * One source's transcript, as `person` may read it now, or null: alike
 * when the source has none, isn't one they may read, or isn't a source.
 * Only a Brain document's, through the Brain (its `authorize` and
 * `onRead` ports): a team's interviews have none (see above).
 */
export const brainTranscript = async (
  env: Env,
  person: Identity,
  sourceId: unknown
): Promise<Transcript | null> => {
  const id = brainErrors.parse("brain.invalid", sourceIdSchema, sourceId);
  if (!id.startsWith(brainSourcePrefix)) {
    return null;
  }
  const documentId = documentIdSchema.safeParse(
    id.slice(brainSourcePrefix.length)
  );
  if (!documentId.success) {
    return null;
  }
  const found = await readTranscript(
    brainOf(env),
    { type: "person", person },
    documentId.data
  );
  return found === undefined ? null : shownTranscript(found.read.transcript);
};
