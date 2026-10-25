import { listTranscripts, readTranscript } from "@grasp-os/brain/transcripts";
import type { Transcript as StoredTranscript } from "@grasp-os/brain/transcripts";
import { actorOf } from "@grasp-os/shared/audit";
import {
  brainErrors,
  brainTranscriptSourcesMax,
  sourceIdSchema,
} from "@grasp-os/shared/brain";
import type {
  Source,
  Statement,
  Team,
  Transcript,
} from "@grasp-os/shared/brain";
import { onboardingIdPrefix } from "@grasp-os/shared/brain-records";
import { documentIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { drizzle } from "drizzle-orm/d1";

import { keepAuditEvent } from "./audit-outbox.ts";
import { readBrainRecords } from "./brain-records.ts";
import type { HeldRecords } from "./brain-records.ts";
import { brainOf } from "./knowledge/ports.ts";

// The brain's sources' transcripts: `brain.read` (brain-rpc.ts) says only
// which sources have one, and how many turns (`Source.transcriptTurns`);
// `brain.transcript` reads one source's turns and chapters when it is
// opened, authorized and audited as that one read, so a page load never
// carries every transcript. Two producers, and nothing else:
//
// - A Knowledge document saved with a transcript (an uploaded WebVTT
//   file, knowledge/uploads.ts): listed and read through the Brain
//   (`listTranscripts`, `readTranscript`), so only from documents the
//   person may read at that moment, as the `authorize` port says, and each
//   recorded as a Knowledge read. Each is a source of its own.
// - A team's interviews: never their words, for anyone, Grasp's staff and
//   admins included. The turns are the team's
//   admitted statements the brain already holds (onboarding/brain-intake.ts:
//   only facts the speaker approved in the read-back, names taken out,
//   once five of the team agreed), one a turn, spoken by the team, in the
//   order of their kind and words so no one person's statements sit
//   together. Nothing is stored for them: withdrawing or correcting an
//   interview takes its statements out of the brain (the onboarding's
//   purge), and the turns with them. Raw lines, the kickoff's transcript
//   and a team lead's interview never become turns. They reach exactly the
//   audience the read-back admitted the statements to (the notice's
//   `company.role_and_team`: the company's Brain, by team and role, never
//   by name), as the statements themselves do: whoever reads the brain.
//   Opening one is recorded (`brain.transcript.read`), by source and count.

/** What a Knowledge document's source id starts with. */
const knowledgeSourcePrefix = "src.knowledge-";

/** A Knowledge document's source, as the brain names it. */
export const knowledgeSourceId = (documentId: string): string =>
  `${knowledgeSourcePrefix}${documentId}`;

/** Whether `id` is a team's interviews, as the onboarding gives them the brain. */
export const isTeamInterviews = (id: string): boolean =>
  id.startsWith(`${onboardingIdPrefix}src-`);

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
 * saved first, at most `brainTranscriptSourcesMax`, each as a source with
 * how many turns it has: never the turns.
 */
export const knowledgeTranscriptSources = async (
  env: Env,
  person: Identity
): Promise<Source[]> => {
  const { transcripts } = await listTranscripts(
    brainOf(env),
    { type: "person", person },
    { limit: brainTranscriptSourcesMax }
  );
  return transcripts.map(({ documentId, title, savedAt, turns }) => ({
    id: knowledgeSourceId(documentId),
    kind: "document",
    title,
    date: dayOf(savedAt),
    transcriptTurns: turns,
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
 * The onboarding's own statements naming `source` (none an admin added:
 * their ids can't be the onboarding's), in the order of their kind and
 * words.
 */
const admittedOf = (
  source: Pick<Source, "id">,
  statements: readonly Statement[]
): Statement[] =>
  statements
    .filter(
      ({ id, sourceId }) =>
        sourceId === source.id && id.startsWith(onboardingIdPrefix)
    )
    .toSorted(
      (one, other) =>
        byText(one.kind, other.kind) || byText(one.text, other.text)
    );

/** How many turns a team's interviews' transcript has: its admitted statements. */
export const interviewTurns = (
  source: Pick<Source, "id">,
  statements: readonly Statement[]
): number => admittedOf(source, statements).length;

/**
 * A team's interviews' transcript: its admitted statements, spoken by
 * `team`; none when there is no statement.
 */
const interviewTranscript = (
  source: Pick<Source, "id">,
  statements: readonly Statement[],
  team: string
): Transcript | undefined => {
  const admitted = admittedOf(source, statements);
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

/**
 * One source's transcript, as `person` may read it now, or null: alike
 * when the source has none, isn't one they may read, or isn't a source.
 * A Knowledge document's through the Brain (its `authorize` and `onRead`
 * ports); a team's interviews' from their admitted statements, which every
 * reader of the brain reads, its opening recorded, spoken by the team as
 * `teamsOf` names it: `brain.read`'s own teams for `person`, so the
 * transcript names the team the page does (a roster team by the roster,
 * for an admin).
 */
export const brainTranscript = async (
  env: Env,
  person: Identity,
  sourceId: unknown,
  teamsOf: (
    records: HeldRecords
  ) => Promise<readonly Pick<Team, "id" | "name">[]>
): Promise<Transcript | null> => {
  const id = brainErrors.parse("brain.invalid", sourceIdSchema, sourceId);
  if (id.startsWith(knowledgeSourcePrefix)) {
    const documentId = documentIdSchema.safeParse(
      id.slice(knowledgeSourcePrefix.length)
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
  }
  if (!isTeamInterviews(id)) {
    return null;
  }
  const records = await readBrainRecords(env);
  const { statements } = records;
  const [teamId] =
    statements.find(({ sourceId: of }) => of === id)?.teamIds ?? [];
  if (teamId === undefined) {
    return null;
  }
  const teams = await teamsOf(records);
  const team = teams.find(({ id: of }) => of === teamId)?.name ?? "";
  const transcript = interviewTranscript({ id }, statements, team);
  if (transcript === undefined) {
    return null;
  }
  await keepAuditEvent(env, drizzle(env.DB), {
    actor: actorOf(person),
    action: "brain.transcript.read",
    target: { type: "source", id },
    detail: { turns: transcript.turns.length },
  });
  return transcript;
};
