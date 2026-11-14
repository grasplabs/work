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
 * chat's code, what that person's teams may read in their own chat in
 * Grasp, in a turn they started, and anywhere else only what everyone in
 * the company may read. Then the parts of the
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
// skills a chat's code does (`env.skills`): Grasp's own and the
// company's. A skill is guidance; it grants nothing.

/**
 * A skill at one version, as a selection names it, Grasp's own (`grasp`)
 * or the company's (`company`): keep it for the whole task, and read that
 * version.
 */
export interface BrainSkill {
  readonly scope: "grasp" | "company";
  readonly name: string;
  readonly version: number;
  /** When to use it. */
  readonly description: string;
}

/** A skill at its version, whole: its `SKILL.md`. */
export interface BrainSkillText {
  readonly scope: "grasp" | "company";
  readonly name: string;
  readonly version: number;
  readonly text: string;
}

// Entities, beside recall: an App's action (`ctx.brain.entities`) and a
// workflow's step (`ctx.brain.<alias>.entities`) read the entities and
// memories everyone in the company may read.

/** What kind of thing an entity is. */
export type BrainEntityKind =
  | "person"
  | "team"
  | "customer"
  | "supplier"
  | "project"
  | "product"
  | "tool"
  | "routine"
  | "app"
  | "workflow"
  | "connection"
  | "term";

/** An entity, as everyone in the company may see it: its ID, kind and earliest name. */
export interface BrainEntity {
  readonly id: string;
  readonly kind: BrainEntityKind;
  readonly name: string | null;
}

/** An exact identifier of an entity: an email address, or a reference such as `crm:ACME-1`. */
export interface BrainIdentifier {
  readonly type: "email" | "ref";
  readonly value: string;
}

/**
 * A memory on a card: what it says (`statement`), the attribute it is
 * filed under and its value, when the Brain learned it (ISO 8601), whether
 * a person confirmed it, and whether another current
 * memory says otherwise (`contested`).
 */
export interface BrainMemory {
  readonly id: string;
  readonly attribute: string | null;
  readonly value: string | null;
  readonly statement: string;
  readonly learnedAt: string;
  readonly confirmed: boolean;
  readonly contested: boolean;
}

/**
 * A page of an entity's card: its current memories by attribute, its
 * relations to other entities, and its memories under no attribute
 * (`notes`). `next`, while more follow, is the `after` of the next page.
 */
export interface BrainCard {
  readonly entity: BrainEntity;
  readonly attributes: readonly {
    readonly attribute: string;
    readonly memories: readonly BrainMemory[];
    readonly contested: boolean;
  }[];
  readonly relations: readonly {
    readonly attribute: string | null;
    readonly side: "about" | "object";
    readonly other: BrainEntity;
    readonly memory: BrainMemory;
  }[];
  readonly notes: readonly BrainMemory[];
  readonly next: string | null;
}

/** Entities to find (`entities.find`): of a kind, by a whole name, or by an exact identifier. */
export interface BrainEntitiesFind {
  readonly kind?: BrainEntityKind;
  readonly name?: string;
  readonly identifier?: BrainIdentifier;
  /** A page's `next`, for the page after it. */
  readonly after?: string;
}

/**
 * `Calls` (each operation's member, by its name) for the operations
 * `Listed`, a dotted one under its group: `entities.get` as
 * `entities.get`, `recall` as itself. None for an operation not listed.
 */
export type BrainMembersOf<Calls, Listed extends keyof Calls & string> = Pick<
  Calls,
  Exclude<Listed, `${string}.${string}`>
> & {
  readonly [
    Group in Listed extends `${infer Prefix}.${string}` ? Prefix : never
  ]: {
    readonly [
      Operation in Extract<
        Listed,
        `${Group}.${string}`
      > as Operation extends `${Group}.${infer Name}` ? Name : never
    ]: Calls[Operation];
  };
};
