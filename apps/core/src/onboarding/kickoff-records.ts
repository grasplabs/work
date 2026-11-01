import { onboardingIdPrefix } from "@grasp-os/shared/brain-records";
import type { BrainRecord } from "@grasp-os/shared/brain-records";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { kickoffVisionFields } from "@grasp-os/shared/kickoff";
import type { KickoffView } from "@grasp-os/shared/kickoff";

import {
  keepOnboardingRecords,
  onboardingRecordsOf,
  retireOnboardingRecords,
} from "../brain-records.ts";
import { ownId, recordOf } from "./brain-intake.ts";

// What the kickoff gives the brain, as its records (GRA-528): the
// company's vision and the teams the sponsor named, each team with the
// size the sponsor gave it. The onboarding decides it, as their owner:
//
// - The vision is the company's, so it is a record every member reads:
//   what the kickoff read about the goals (its ambition) and the pain (why
//   now), each with the sponsor's answer beside it. Never the transcript,
//   and never a quote: the reading's texts name roles, never people.
// - The vision is shared with everyone, the sponsor's answers too: the
//   staff form they are typed in says so.
// - Records are never written over: when the vision or a team's size
//   changes (the sponsor answering), a new one is added and the newest
//   counts. The same again adds nothing, so a retry keeps nothing twice.
// - A transcript brought in replaces the one before: what the old one gave
//   is retired (kept, never deleted, and no longer read), and the new
//   one's records take its place. Each record's id carries the transcript
//   it came from, so a replaced kickoff never revives a retired record,
//   and openly (`onb-<kind>-<transcript>-…`): what is retired is whatever
//   isn't the kickoff's current transcript's.
// - The store gives them, under its brain lock, from its kickoff as it is
//   then: two saves at once, or an answer beside a save, leave the newest
//   transcript's records; one after a purge forgot the kickoff
//   (kickoff-erasure.ts) gives nothing.
// - A team is a team record by the name the sponsor gave it; a roster team
//   of the same name is the same team (`brain.read` joins them).

/** The kickoff, as the source the vision and its teams were found in. */
export const kickoffSourceId = "src-kickoff";

/** The kinds of the onboarding's ids (`onb-<kind>-…`) for what the kickoff gives the brain. */
const kinds = { vision: "vis", team: "kt", count: "kc" } as const;

/** Whether `id` is a team the kickoff named, as its record. */
export const isKickoffTeam = (id: string): boolean =>
  id.startsWith(`${onboardingIdPrefix}${kinds.team}-`);

/** What the kickoff said about `field` and what the sponsor answered, each on its own line; empty if neither. */
export const kickoffSaid = (
  kickoff: KickoffView,
  field: "business" | "goals" | "pain"
): string =>
  [kickoff.reading?.fields[field]?.text, kickoff.answers[field]]
    .map((each) => each?.trim() ?? "")
    .filter((each) => each !== "")
    .join("\n");

/** The transcript `at` as the ids of its records carry it. */
const transcriptTag = async (at: string): Promise<string> => {
  const hash = await sha256Hex(at);
  return hash.slice(0, 12);
};

/** The kind of a record of the transcript tagged `tag`, as its id has it. */
const kindOf = (kind: string, tag: string): string => `${kind}-${tag}`;

/** The newest vision the kickoff's transcript gave the brain, if any: what a change follows. */
type Given = { id: string; ambition: string; whyNow: string } | null;

const givenOf = async (env: Env): Promise<Given> => {
  const visions = await onboardingRecordsOf(env, "vision", `${kinds.vision}-`);
  let given: Given = null;
  for (const record of visions) {
    if (record.type === "vision") {
      given = record;
    }
  }
  return given;
};

/**
 * The records the kickoff's transcript gives the brain beside the vision
 * it `given` before: a new vision when it changed, and each team it
 * names, with its size. A new vision's id follows from the one it comes
 * after, so the same change twice is one record, and a change back to an
 * earlier vision is a new one; a team's and its size's, from the
 * transcript, so giving them again keeps nothing twice.
 */
const kickoffRecordsOf = async (
  kickoff: KickoffView,
  given: Given
): Promise<BrainRecord[]> => {
  if (kickoff.transcript === null) {
    return [];
  }
  /** The transcript the records come from: when it was brought in. */
  const { at } = kickoff.transcript;
  const tag = await transcriptTag(at);
  const date = at.slice(0, 10);
  const ambition = kickoffSaid(kickoff, kickoffVisionFields.ambition);
  const whyNow = kickoffSaid(kickoff, kickoffVisionFields.whyNow);
  const records: BrainRecord[] = [];
  const unchanged =
    given === null
      ? ambition === "" && whyNow === ""
      : given.ambition === ambition && given.whyNow === whyNow;
  if (!unchanged) {
    records.push(
      ...recordOf({
        type: "vision",
        id: await ownId(
          kindOf(kinds.vision, tag),
          at,
          given?.id ?? "",
          ambition,
          whyNow
        ),
        ambition,
        whyNow,
        sourceId: kickoffSourceId,
        date,
      })
    );
  }
  const named = new Set<string>();
  for (const { name, people } of kickoff.reading?.teams ?? []) {
    // oxlint-disable-next-line no-await-in-loop -- a hash each, in order
    const teamId = await ownId(kindOf(kinds.team, tag), at, name);
    // A team named twice in one reading is one record: its first size counts.
    if (named.has(teamId)) {
      continue;
    }
    named.add(teamId);
    const team = recordOf({
      type: "team",
      id: teamId,
      name,
      sourceId: kickoffSourceId,
    });
    records.push(...team);
    if (team.length === 0 || people === undefined) {
      continue;
    }
    records.push(
      ...recordOf({
        type: "teamCount",
        // oxlint-disable-next-line no-await-in-loop -- a hash each, in order
        id: await ownId(kindOf(kinds.count, tag), teamId, String(people)),
        teamId,
        sourceId: kickoffSourceId,
        date,
        people,
      })
    );
  }
  return records;
};

/**
 * Gives the brain what `kickoff` holds now, as the onboarding, which owns
 * those records: kept once each, so giving it again adds only what
 * changed. Then what any transcript but `kickoff`'s gave is retired, so
 * the brain is never left without a vision. Only ever called by the
 * store, with its kickoff as it is now and under its brain lock
 * (`keepKickoffRecords` there): a save or an answer that lands after a
 * newer save, or after a purge forgot the kickoff, gives nothing of its
 * own. Each step is audited with its records.
 */
export const keepKickoffRecords = async (
  env: Env,
  kickoff: KickoffView,
  { replaced }: { replaced: boolean }
): Promise<void> => {
  if (kickoff.transcript === null) {
    return;
  }
  const records = await kickoffRecordsOf(
    kickoff,
    replaced ? null : await givenOf(env)
  );
  if (records.length > 0) {
    await keepOnboardingRecords(env, records, {
      sources: new Set([kickoffSourceId]),
      teams: new Set(),
    });
  }
  const tag = await transcriptTag(kickoff.transcript.at);
  const current = Object.values(kinds).map(
    (kind) => `${onboardingIdPrefix}${kindOf(kind, tag)}-`
  );
  await retireOnboardingRecords(
    env,
    Object.values(kinds).map((kind) => `${kind}-`),
    (id) => current.some((prefix) => id.startsWith(prefix))
  );
};
