import { kickoffVisionFields } from "@grasp-os/shared/kickoff";
import type { KickoffView } from "@grasp-os/shared/kickoff";

// What the kickoff gives the whole company (GRA-528, GRA-1748): the
// vision, as what the kickoff read about the goals (its ambition) and the
// pain (why now), each with the sponsor's answer beside it, and the teams
// it named, each with the size the sponsor gave it. Never the transcript,
// never a quote and never another field: the reading's texts name roles,
// never people, and the staff form the answers are typed in says they are
// shared with everyone.
//
// The onboarding's store keeps the kickoff (onboarding/store.ts); this is
// the one definition of the part every member reads, for the Brain page
// (brain-rpc.ts) and for the new Brain, which holds it as a source
// readable by everyone (onboarding/new-brain.ts `kickoffOf`).

/** What the kickoff said about `field` and what the sponsor answered, each on its own line; empty if neither. */
export const kickoffSaid = (
  kickoff: KickoffView,
  field: "business" | "goals" | "pain"
): string =>
  [kickoff.reading?.fields[field]?.text, kickoff.answers[field]]
    .map((each) => each?.trim() ?? "")
    .filter((each) => each !== "")
    .join("\n");

/** The kickoff as every member may read it. */
export interface CompanyKickoff {
  /** When its transcript came in (ISO 8601). */
  at: string;
  ambition: string;
  whyNow: string;
  /** The teams it named, each once by name, in its order, with their size when said. */
  teams: { name: string; people?: number }[];
}

/** What every member reads of `kickoff`; null before its transcript is in. */
export const companyKickoffOf = (
  kickoff: KickoffView
): CompanyKickoff | null => {
  if (kickoff.transcript === null) {
    return null;
  }
  const teams = new Map<string, { name: string; people?: number }>();
  for (const { name, people } of kickoff.reading?.teams ?? []) {
    // A team named twice in one reading is one team: its first size counts.
    if (!teams.has(name)) {
      teams.set(name, people === undefined ? { name } : { name, people });
    }
  }
  return {
    at: kickoff.transcript.at,
    ambition: kickoffSaid(kickoff, kickoffVisionFields.ambition),
    whyNow: kickoffSaid(kickoff, kickoffVisionFields.whyNow),
    teams: [...teams.values()],
  };
};

/**
 * `company` as the new Brain's source text, for recall: written for a
 * model to read, in English like the rest of Grasp's own words to it.
 * Empty when it says nothing.
 */
export const companyKickoffText = (company: CompanyKickoff): string => {
  const parts = [
    ...(company.ambition === ""
      ? []
      : [
          `## The company's goals for the next one to two years\n${company.ambition}`,
        ]),
    ...(company.whyNow === ""
      ? []
      : [`## Why the company wants AI now\n${company.whyNow}`]),
    ...(company.teams.length === 0
      ? []
      : [
          `## The company's teams\n${company.teams
            .map(({ name, people }) =>
              people === undefined ? `- ${name}` : `- ${name}: ${people} people`
            )
            .join("\n")}`,
        ]),
  ];
  return parts.length === 0
    ? ""
    : `# The company's vision, from Grasp's first conversation with it\n\n${parts.join("\n\n")}`;
};
