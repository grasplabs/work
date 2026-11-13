// The Brain's recall, as every caller reaches it: an App's action
// (`ctx.brain.recall`), a workflow's step (`ctx.brain.<alias>.recall`) and
// a chat's code (`env.brain.recall`) send the same request and get the
// same pack. These types are the SDK's own; a type test holds them to the
// Brain's contract (`test/brain-recall.test-d.ts`), and core's recall
// answers a value of them.

/** What to recall. */
export interface BrainRecall {
  /** The question, in the asker's words: at most 2,000 characters. */
  readonly question: string;
  /** How many tokens the pack may hold: a whole number, 1 to 32,000. */
  readonly budget: { readonly tokens: number };
  /**
   * Read each source as it was at this moment, an ISO 8601 date-time with
   * its offset, to the millisecond and including it. For "on 14 March
   * 2026" in Amsterdam pass that day's last millisecond,
   * `2026-03-14T23:59:59.999+01:00`, not its midnight. Left out: now.
   */
  readonly asOf?: string;
}

/**
 * How recall found a passage: as the question wrote one of its IDs or
 * quoted phrases (`exact`), by its telling words in any form (`words`), by
 * its commonest words alone (`stop words`), which is no answer by itself,
 * or by meaning alone (`meaning`).
 */
export type BrainFound = "exact" | "words" | "stop words" | "meaning";

/**
 * A passage of a pack, cited by its source (what kind of thing added it,
 * `producer`, such as an upload, a chat or a run, and its `id`), the
 * source's version and the passage's place in it, from 0: the part that
 * best answers the question, or the whole passage (`whole`).
 */
export interface BrainPackItem {
  readonly source: {
    readonly producer: "upload" | "chat" | "run";
    readonly id: string;
  };
  readonly version: number;
  readonly position: number;
  readonly text: string;
  readonly whole: boolean;
  readonly found: BrainFound;
}

/**
 * What answers the question, best first, within the budget: from an App
 * or a workflow, only what everyone in the company may read (never a
 * team's content, nor anyone's private chats or personal files); from a
 * chat's code, what that person's teams may read. Then the parts of the
 * question nothing it may read holds (`notFound`), and whether the budget
 * left out or shortened a passage found (`truncated`).
 */
export interface BrainPack {
  readonly items: readonly BrainPackItem[];
  readonly notFound: readonly string[];
  readonly truncated: boolean;
}

// Skills, beside recall: an App's action (`ctx.brain.skills`) and a
// workflow's step (`ctx.brain.<alias>.skills`) select and read the same
// skills a chat's code does (`env.skills`), from the Brain, of what
// everyone in the company may read. A skill is guidance; it grants
// nothing.

/** Whose a skill is: Grasp's own, or the company's. */
export type BrainSkillScope = "grasp" | "company";

/**
 * A skill at one version, as a selection names it: keep it for the whole
 * task, and read that version.
 */
export interface BrainSkill {
  readonly scope: BrainSkillScope;
  readonly name: string;
  readonly version: number;
  /** When to use it. */
  readonly description: string;
}

/** What to select skills for: a task, in your words, at most 2,000 characters. */
export interface BrainSkillsSelect {
  readonly task: string;
}

/**
 * The skills that apply to a task, best first, a few at most: none when
 * none shares the task's telling words. Go without one then, never with a
 * skill that only seems close.
 */
export interface BrainSkillsSelected {
  readonly skills: readonly BrainSkill[];
}

/** What to read: a skill at exactly the version a selection gave. */
export interface BrainSkillRead {
  readonly skill: {
    readonly scope: BrainSkillScope;
    readonly name: string;
    readonly version: number;
  };
}

/** A skill at its version, whole: its `SKILL.md`. */
export interface BrainSkillText {
  readonly scope: BrainSkillScope;
  readonly name: string;
  readonly version: number;
  readonly text: string;
}
