import { defineErrorFamily } from "./errors.ts";

// Skills: how things are done here, as `SKILL.md` documents kept in the
// Brain: Grasp's own (shipped with each release), the company's and each
// team's shared ones, and each person's own (core's brain-skills.ts and
// skill-shares.ts).

/** Why a skill couldn't be selected, read, written or shared. */
export const skillErrors = defineErrorFamily({
  "skills.invalid": "That isn't a task or a skill.",
  "skills.not_found": "There's no such skill, or not at that version.",
  "skills.name_erased":
    "You deleted a skill of that name for good: give this one another name.",
  "skills.not_in_team": "You can share a skill only with a team you're in.",
});

/** A skill as the skills page lists it: its name, version and when to use it. */
export interface ListedSkill {
  name: string;
  version: number;
  description: string;
}

/** A skill at one version, whole: its `SKILL.md`. */
export interface SkillText {
  name: string;
  version: number;
  text: string;
}

/** One of the company's teams, by its ID and its name. */
export interface SkillTeam {
  id: string;
  name: string;
}

/**
 * Whom a skill is shared with, as a share is asked: the company, or one of
 * the asker's teams, by its ID.
 */
export type SkillAudienceAsked = "company" | { team: string };

/**
 * Whom a share is for: every member of the company, or one team's members
 * (its name null once the team is gone).
 */
export type SkillShareAudience =
  | { kind: "company" }
  | { kind: "team"; team: { id: string; name: string | null } };

/**
 * Where a share of a skill stands: waiting for an admin; approved (its
 * audience's from then on: added once its `version` is set); or declined.
 */
export type SkillShareStatus = "pending" | "approved" | "declined";

/** A person's ask to share one of their own skills with the company or a team. */
export interface SkillShare {
  id: string;
  name: string;
  audience: SkillShareAudience;
  status: SkillShareStatus;
  /** ISO 8601. */
  requestedAt: string;
  requestedBy: { userId: string; name: string | null };
  /** ISO 8601; null while it waits. */
  decidedAt: string | null;
  /** The shared skill's version its approval made; null until it did. */
  version: number | null;
  /**
   * Approved, but a later decision on the skill's name (another approval,
   * a retirement) came before it was added: it never will be.
   */
  superseded: boolean;
}

/** One of the person's own shares, as their own page lists it. */
export interface OwnSkillShare extends SkillShare {
  /**
   * Whether it waits with a text other than their skill's current one: they
   * saved a newer version since asking, so asking again shares that one.
   */
  outdated: boolean;
  /**
   * Whether its audience has a skill of its name in use now, as core's
   * decisions have it (its own or a later one), whether or not the person
   * is still in that audience.
   */
  inUse: boolean;
}

/** A share waiting for an admin, with the exact text an approval adds. */
export interface SkillShareRequest extends SkillShare {
  text: string;
  /**
   * What approving it replaces for its audience (everyone, or the team's
   * members): the team's own skill of its name, the company's, one of
   * Grasp's own, or nothing (null).
   */
  replaces: "team" | "company" | "grasp" | null;
}

/** A team's skill, as the skills page lists it to that team's members. */
export interface ListedTeamSkill extends ListedSkill {
  team: SkillTeam;
}

/**
 * Where a shared skill stands, as core's decisions have it: the version
 * its audience's agents use now (null while none is), and what an admin's
 * latest decision on it is bringing, not added yet: a new version, its
 * retirement, or nothing (null).
 */
export interface SkillInUse {
  version: number | null;
  onItsWay: "version" | "retirement" | null;
}

/**
 * A team's skill as core's decisions have it, for admins: its team (its
 * name null once the team is gone), its name, and where it stands.
 */
export interface DecidedTeamSkill extends SkillInUse {
  team: { id: string; name: string | null };
  name: string;
}

/**
 * A company skill as the skills page lists it: its name, when to use it
 * (null until a version is in use), and where it stands.
 */
export interface CompanySkill extends SkillInUse {
  name: string;
  description: string | null;
}

/** What the skills page shows the signed-in person. */
export interface SkillsOverview {
  /** Their own skills, for them alone. */
  own: ListedSkill[];
  /** The company's skills, which every member's agents use. */
  company: CompanySkill[];
  /** The skills of the teams they are in, which those teams' members' agents use. */
  team: ListedTeamSkill[];
  /** The teams they are in, which they may share a skill with. */
  teams: SkillTeam[];
  /** Their own asks to share, newest first. */
  shares: OwnSkillShare[];
  /**
   * For the organization's own admins: every share that waits for a
   * decision, oldest first, and approved ones still to finish. Null for
   * anyone else.
   */
  requests: SkillShareRequest[] | null;
  /**
   * For the organization's own admins: every team's skill in use, by its
   * team and name, whether or not they are in the team, to retire one.
   * Null for anyone else.
   */
  teamSkills: DecidedTeamSkill[] | null;
}

/**
 * Skills over `/rpc` (`session.skills`): a person's own, which they write
 * and delete; sharing one with the company or one of their teams, which
 * waits for an admin; and, for admins, deciding shares and retiring
 * shared skills. Only a
 * person on their own session reaches it: agents never write, share or
 * approve a skill.
 */
export interface SkillsApi {
  /** Their own skills, the company's, their shares, and for admins the requests. */
  overview: () => Promise<SkillsOverview>;
  /** One of their own skills (`own`) or the company's, at its current version. */
  read: (scope: "own" | "company", name: string) => Promise<SkillText>;
  /**
   * Saves `text`, a `SKILL.md`, as the next version of their own skill
   * of the name its frontmatter gives; the one before stays as history.
   */
  save: (text: string) => Promise<ListedSkill>;
  /** Erases their own skill `name` for good, with every version, and their waiting share of it. */
  remove: (name: string) => Promise<void>;
  /**
   * Asks to share their own skill `name`, exactly as it is at `version`,
   * with the company or one of their teams: it waits for an admin,
   * replacing a share of it with the same audience that waits already.
   */
  share: (
    name: string,
    version: number,
    audience: SkillAudienceAsked
  ) => Promise<SkillShare>;
  /** Admins: approves the share `id`, adding its text as its audience's skill. */
  approve: (id: string) => Promise<SkillShare>;
  /** Admins: declines the share `id`; its text is dropped. */
  decline: (id: string) => Promise<SkillShare>;
  /**
   * Admins: retires the company's or a team's skill `name`: no one uses it
   * from then on; its versions stay as history.
   */
  retire: (name: string, audience: SkillAudienceAsked) => Promise<void>;
}
