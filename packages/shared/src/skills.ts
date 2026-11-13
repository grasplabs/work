import { defineErrorFamily } from "./errors.ts";

// Skills: how things are done here, as `SKILL.md` documents kept in the
// Brain: Grasp's own (shipped with each release), the company's shared
// ones, and each person's own (core's brain-skills.ts and
// skill-shares.ts).

/** Why a skill couldn't be selected, read, written or shared. */
export const skillErrors = defineErrorFamily({
  "skills.invalid": "That isn't a task or a skill.",
  "skills.not_found": "There's no such skill, or not at that version.",
  "skills.name_erased":
    "You deleted a skill of that name for good: give this one another name.",
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

/**
 * Where a share of a skill stands: waiting for an admin; approved (the
 * company's from then on: added once its `version` is set); or declined.
 */
export type SkillShareStatus = "pending" | "approved" | "declined";

/** A person's ask to share one of their own skills with the company. */
export interface SkillShare {
  id: string;
  name: string;
  status: SkillShareStatus;
  /** ISO 8601. */
  requestedAt: string;
  requestedBy: { userId: string; name: string | null };
  /** ISO 8601; null while it waits. */
  decidedAt: string | null;
  /** The company skill's version its approval made; null until it did. */
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
}

/** A share waiting for an admin, with the exact text an approval adds. */
export interface SkillShareRequest extends SkillShare {
  text: string;
  /**
   * What approving it replaces for everyone: the company's live skill of
   * its name, one of Grasp's own of its name, or nothing (null).
   */
  replaces: "company" | "grasp" | null;
}

/** What the skills page shows the signed-in person. */
export interface SkillsOverview {
  /** Their own skills, for them alone. */
  own: ListedSkill[];
  /** The company's skills, which every member's agents use. */
  company: ListedSkill[];
  /** Their own asks to share, newest first. */
  shares: OwnSkillShare[];
  /**
   * For the organization's own admins: every share that waits for a
   * decision, oldest first, and approved ones still to finish. Null for
   * anyone else.
   */
  requests: SkillShareRequest[] | null;
}

/**
 * Skills over `/rpc` (`session.skills`): a person's own, which they write
 * and delete; sharing one with the company, which waits for an admin; and,
 * for admins, deciding shares and retiring the company's skills. Only a
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
   * with the company: it waits for an admin, replacing a share of it that
   * waits already.
   */
  share: (name: string, version: number) => Promise<SkillShare>;
  /** Admins: approves the share `id`, adding its text as the company's skill. */
  approve: (id: string) => Promise<SkillShare>;
  /** Admins: declines the share `id`; its text is dropped. */
  decline: (id: string) => Promise<SkillShare>;
  /** Admins: retires the company's skill `name`: no one uses it from then on; its versions stay as history. */
  retire: (name: string) => Promise<void>;
}
