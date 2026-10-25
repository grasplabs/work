import { readTranscripts } from "@grasp-os/brain/transcripts";
import type { Transcript as StoredTranscript } from "@grasp-os/brain/transcripts";
import { brainTranscriptsMaxRead } from "@grasp-os/shared/brain";
import type { Source, Statement, Transcript } from "@grasp-os/shared/brain";
import { onboardingIdPrefix } from "@grasp-os/shared/brain-records";
import type { Identity } from "@grasp-os/shared/rpc";

import { brainOf } from "./knowledge/ports.ts";

// The brain's sources' transcripts (`Source.transcript`), as `brain.read`
// serves them (brain-rpc.ts). Two producers, and nothing else:
//
// - A Knowledge document saved with a transcript (an uploaded WebVTT
//   file, knowledge/uploads.ts): read through the Brain
//   (`readTranscripts`), so only from documents the person may read now,
//   as the `authorize` port says, and recorded as a Knowledge read. Each
//   is a source of its own.
// - A team's interviews: never their words. The turns are the team's
//   admitted statements the brain already holds (onboarding/brain-intake.ts:
//   only facts the speaker approved in the read-back, names taken out,
//   once five of the team agreed), one a turn, spoken by the team, in the
//   order of their kind and words so no one person's statements sit
//   together. Nothing is stored for them: withdrawing or correcting an
//   interview takes its statements out of the brain (the onboarding's
//   purge), and the turns with them. Raw lines, the kickoff's transcript
//   and a team lead's interview never become turns.

/** A Knowledge document's source, as the brain names it. */
export const knowledgeSourceId = (documentId: string): string =>
  `src.knowledge-${documentId}`;

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
 * The Knowledge documents with a transcript `person` may read now, newest
 * saved first, at most `brainTranscriptsMaxRead`, each as a source.
 */
export const knowledgeTranscriptSources = async (
  env: Env,
  person: Identity
): Promise<Source[]> => {
  const { transcripts } = await readTranscripts(
    brainOf(env),
    { type: "person", person },
    { limit: brainTranscriptsMaxRead }
  );
  return transcripts.map(({ documentId, title, savedAt, transcript }) => ({
    id: knowledgeSourceId(documentId),
    kind: "document",
    title,
    date: dayOf(savedAt),
    transcript: shownTranscript(transcript),
  }));
};

/** Two texts in a fixed order, whatever the locale. */
const byText = (one: string, other: string): number => {
  if (one === other) {
    return 0;
  }
  return one < other ? -1 : 1;
};

/**
 * A team's interviews' transcript: the onboarding's own statements naming
 * its source (none an admin added: their ids can't be the onboarding's),
 * spoken by `team`; none when there is no statement.
 */
export const interviewTranscript = (
  source: Pick<Source, "id">,
  statements: readonly Statement[],
  team: string
): Transcript | undefined => {
  const admitted = statements
    .filter(
      ({ id, sourceId }) =>
        sourceId === source.id && id.startsWith(onboardingIdPrefix)
    )
    .toSorted(
      (one, other) =>
        byText(one.kind, other.kind) || byText(one.text, other.text)
    );
  if (admitted.length === 0) {
    return undefined;
  }
  return {
    unit: "passage",
    turns: admitted.map(({ text }, index) => ({
      at: String(index + 1),
      speaker: team,
      text,
    })),
    chapters: [],
  };
};
