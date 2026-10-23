import { z } from "zod";

import { rosterPersonSchema, rosterTeamSchema } from "./onboarding.ts";

// The organization as Grasp knows it (core's onboarding/organization.ts):
// every team with its lead, its people and where each stands, its map of
// the work and who is asked about which piece, when its links go out, and
// what needs a look there. Grasp's staff read it and put the list right
// while the interviews run; every change is in the onboarding's log, as
// the staff member who made it. For staff sessions only. From the
// prototype (grasplabs/prototype, packages/grasp: `lib/admin-organization.ts`
// and `staffRoster` in `worker/org-store.ts`).

/**
 * Where someone stands: their team doesn't take part; away these weeks;
 * no link out yet; out, opened, begun; or talked, and agreed to what was
 * read back.
 */
export const memberStates = [
  "out",
  "away",
  "waiting",
  "sent",
  "opened",
  "started",
  "talked",
] as const;
export type MemberState = (typeof memberStates)[number];

/** Someone on the list, as staff see them. */
export interface OrganizationPerson {
  id: string;
  name: string;
  email: string;
  title: string;
  team: string;
  away: boolean;
  /** Leads their team: asked about all of its work. */
  lead: boolean;
  state: MemberState;
  /** The piece of work Stephen asks them about, by id; null when he asks which they do. */
  work: string | null;
}

/** One of a team's pieces of work, as its lead's map has it. */
export interface OrganizationWork {
  id: string;
  /** In English, and in the team's language. */
  name: string;
  local: string;
  /** Its part of the team's time, 0 to 1. */
  share: number;
  /** Who does it, by person, as far as the record goes: only those on the list. */
  doers: string[];
}

/** What about a team needs a look, the most pressing first. */
export type TeamFlag =
  /** It takes part and nobody leads it: its people each say what work they do. */
  | { kind: "noLead" }
  /** Its lead's link is out for `leadWaitWorkingDays` and they haven't talked. */
  | { kind: "leadLate"; lead: string }
  /** Its lead talked, and no map came of it: drawing failed, or no work was named. */
  | { kind: "noMap" }
  /** A piece of work nobody on the list does. */
  | { kind: "nobody"; work: string }
  /** People asked about no piece of work though the map names some. */
  | { kind: "unasked"; count: number };

/** When a team's links go out. */
export type TeamTurn =
  /** It doesn't take part. */
  | { kind: "off" }
  /** No plan yet, or its moment isn't planned. */
  | { kind: "unplanned" }
  /** At its own moment, still to come (ISO 8601). */
  | { kind: "from"; at: string }
  /**
   * The lead's is out or going; everyone else's waits for the lead's
   * interview and the team's map, until `by` at the latest (an ISO day).
   */
  | { kind: "lead"; lead: string; by: string }
  /** Everyone's is due: out, or out once the interviews run. */
  | { kind: "due" }
  /** Everyone taking part has their link. */
  | { kind: "out" };

export interface OrganizationTeam {
  id: string;
  name: string;
  does: string;
  off: boolean;
  lead: string | null;
  works: OrganizationWork[];
  /** Its lead agreed to something: staff can draw its map again. */
  drawable: boolean;
  turn: TeamTurn;
  flags: TeamFlag[];
}

/** The organization as Grasp's staff see it. */
export interface StaffOrganization {
  teams: OrganizationTeam[];
  people: OrganizationPerson[];
  /** Links go out: a plan, the agreements in, not paused. */
  open: boolean;
}

const teamId = rosterTeamSchema.shape.id;
const personId = rosterPersonSchema.shape.id;
const teamFields = {
  name: rosterTeamSchema.shape.name,
  does: rosterTeamSchema.shape.does,
};
const personFields = {
  name: rosterPersonSchema.shape.name,
  email: rosterPersonSchema.shape.email,
  title: rosterPersonSchema.shape.title,
  team: teamId,
};

/**
 * One change staff make to the list: a team added, renamed, left out or
 * asked in again, its lead picked; someone added, changed or moved, away
 * or back, or taken off; the piece of work someone is asked about (null:
 * Stephen asks which they do); a link sent now; a team's map drawn again.
 */
export const organizationChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("addTeam"), ...teamFields }),
  z.strictObject({ kind: z.literal("editTeam"), team: teamId, ...teamFields }),
  z.strictObject({
    kind: z.literal("takesPart"),
    team: teamId,
    takes: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("lead"),
    team: teamId,
    person: personId.nullable(),
  }),
  z.strictObject({ kind: z.literal("addPerson"), ...personFields }),
  z.strictObject({
    kind: z.literal("editPerson"),
    person: personId,
    ...personFields,
  }),
  z.strictObject({
    kind: z.literal("away"),
    person: personId,
    away: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("removePerson"), person: personId }),
  z.strictObject({
    kind: z.literal("askAbout"),
    person: personId,
    work: z.string().min(1).max(60).nullable(),
  }),
  z.strictObject({ kind: z.literal("send"), person: personId }),
  z.strictObject({ kind: z.literal("draw"), team: teamId }),
]);
export type OrganizationChange = z.output<typeof organizationChangeSchema>;
export type OrganizationChangeInput = z.input<typeof organizationChangeSchema>;
