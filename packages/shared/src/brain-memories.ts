import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// What the Brain keeps of what a person says in their own chat (core's
// agent-remember.ts): the chat shows a notice of each memory saved, and
// the person can undo it there, which retires the memory: it stops being
// used, and stays as history.

/**
 * A memory the agent saved in a person's own chat, as the chat shows it:
 * its id, to undo it, and what it says, in the person's own words.
 */
export const chatSavedMemorySchema = z.strictObject({
  memory: z.uuid(),
  /**
   * What kind it is: a fact or a decision, or how Grasp should act for
   * them (a preference or an instruction), which the notice says.
   */
  type: z.enum(["fact", "decision", "preference", "instruction"]),
  statement: z.string().min(1),
  /** The value it holds of its attribute, when it has one. */
  value: z.string().min(1).optional(),
  /** Who or what it is about, by name, when it isn't the person themselves. */
  about: z.string().min(1).optional(),
});
export type ChatSavedMemory = z.infer<typeof chatSavedMemorySchema>;

/**
 * What a change of a memory did. Undoing a saved one: `done`, also for one
 * undone before or one a later save had replaced; `nothing` alike for
 * none (an erased one included), another's, or an expired one. Confirming
 * one: `done`, or `nothing` alike for none, one they may not read, or one
 * no longer current.
 */
export type BrainMemoryOutcome = "done" | "nothing";

// The Brain's Memories page (`session.brainMemories`, GRA-1746): the
// entities a person may see, by kind; what the Brain remembers about one,
// history included, each memory with where it came from; the facts sources
// disagree on; and the person's confirmation or correction. Core answers
// each from what they may read alone, as if nothing else existed. An
// entity and a memory are in one of two stores: the person's own, whose
// content is theirs alone (nobody else sees it, admins included), or the
// shared one; their ids are the store's own, so each is named with its
// store.

/** The kinds of entity the Brain knows, as its contract lists them. */
export const brainEntityKinds = [
  "person",
  "team",
  "customer",
  "supplier",
  "project",
  "product",
  "tool",
  "routine",
  "app",
  "workflow",
  "connection",
  "term",
] as const;
export type BrainEntityKind = (typeof brainEntityKinds)[number];

/** Every attribute a memory can be filed under, of any kind, as the Brain's contract lists them. */
export const brainMemoryAttributes = [
  "account_owner",
  "availability",
  "complaint",
  "contact",
  "contract_end",
  "contract_value",
  "cost",
  "customer",
  "deadline",
  "decision",
  "definition",
  "description",
  "employer",
  "expertise",
  "feature",
  "frequency",
  "goal",
  "industry",
  "instruction",
  "language",
  "lead",
  "location",
  "manager",
  "member",
  "next_step",
  "owner",
  "owns",
  "preference",
  "price",
  "promise",
  "purpose",
  "renewal_date",
  "requirement",
  "responsibility",
  "role",
  "status",
  "step",
  "supplies",
  "synonym",
  "team",
  "terms",
  "trigger",
  "used_by",
  "uses",
] as const;
export type BrainMemoryAttribute = (typeof brainMemoryAttributes)[number];

/**
 * A store's own place in one of its listings, its times as ISO 8601. Made
 * by core: pass it back as it came.
 */
export type BrainStoreCursor = Readonly<
  Record<string, string | boolean | null>
>;

/** Which store: the person's own (theirs alone), or the shared one. */
export type BrainMemoryStore = "own" | "shared";

/** An entity, by its store and that store's id for it. */
export interface BrainEntityRef {
  store: BrainMemoryStore;
  id: string;
}

/**
 * An entity as the person may see it: its kind and the earliest name they
 * may see, if any. One of their own that a correction made is named live
 * by the shared entity it stands for; `unreadable` when they may no
 * longer read that one (no name is kept for it).
 */
export interface BrainEntityListed {
  entity: BrainEntityRef;
  kind: BrainEntityKind;
  name: string | null;
  unreadable: boolean;
}

/**
 * Where the next page of a listing goes on: in which store, and the
 * store's own place in it (absent: from its start). Made by core: pass it
 * back as it came.
 */
export interface BrainMemoryPageNext {
  store: BrainMemoryStore;
  after?: BrainStoreCursor;
}

/** A page of entities, and where the next goes on: null at the last. */
export interface BrainEntityPage {
  entities: BrainEntityListed[];
  next: BrainMemoryPageNext | null;
}

/** A memory, as the person may read it. Times are ISO 8601. */
export interface BrainMemoryShown {
  /** Its store and that store's id. */
  store: BrainMemoryStore;
  id: string;
  /** The entity it is about, in the same store. */
  about: string;
  attribute: BrainMemoryAttribute | null;
  /** The entity it relates to, for a relation, with its earliest name they may see. */
  object: { id: string; name: string | null } | null;
  value: string | null;
  type: "fact" | "decision" | "preference" | "instruction";
  statement: string;
  quote: string | null;
  /** The source version it was drawn from; null for someone's own word. */
  source: { source: BrainMemorySourceRef; version: number } | null;
  /** Whether it is the person's own word (they wrote it). */
  yours: boolean;
  learnedAt: string;
  /** When it stopped being believed, as they see it; null while current. */
  endedAt: string | null;
  /** A confirmation they may see: when, and whether it was theirs. */
  confirmed: { at: string; byYou: boolean } | null;
  /** Another source they may read says something else. */
  contested: boolean;
}

/** A source a memory was drawn from, as its producer names it. */
export interface BrainMemorySourceRef {
  producer: "upload" | "chat" | "run";
  id: string;
}

/** A page of what the Brain remembers about an entity, and where the next goes on: null at the last. */
export interface BrainMemoryPage {
  memories: BrainMemoryShown[];
  next: BrainStoreCursor | null;
}

/**
 * A fact sources disagree on: an entity's attribute, and the first of its
 * sides (its current memories) as the Brain gives them; `more` when it
 * has more sides than those, all of them on the entity's own page.
 */
export interface BrainContestedFact {
  about: BrainEntityListed;
  attribute: BrainMemoryAttribute;
  sides: BrainMemoryShown[];
  more: boolean;
}

/** A page of contested facts, and where the next goes on: null at the last. */
export interface BrainContestedPage {
  facts: BrainContestedFact[];
  next: BrainMemoryPageNext | null;
}

/** A memory, by its store and id, with the entity it is about. */
export interface BrainMemoryRef {
  store: BrainMemoryStore;
  entity: string;
  memory: string;
}

/** Most characters of a correction: the Brain's bound on a memory's value. */
export const brainCorrectionMaxLength = 500;

/**
 * A correction of a memory: what is right, in the person's own words, and
 * the id of this one correction, minted once when they start it, so a
 * retry saves it once.
 */
export interface BrainCorrection {
  wrong: BrainMemoryRef;
  right: string;
  change: string;
}

/**
 * What a correction saved: the person's own memory, theirs alone; the
 * same again for a retry of it. Null when the memory isn't one they may
 * read, alike for one there isn't.
 */
export type BrainCorrected = { memory: string; entity: string } | null;

/** The person's memories, over `/rpc` as `session.brainMemories`. */
export interface BrainMemoriesApi {
  /** Undoes a memory saved for them in their own word: it stops being current, and stays as history. */
  forget: (memory: string) => Promise<BrainMemoryOutcome>;
  /** A page of the entities of `kind` they may see: their own store's first, then the shared one's. */
  entities: (
    kind: BrainEntityKind,
    next?: BrainMemoryPageNext | null
  ) => Promise<BrainEntityPage>;
  /** An entity, as they may see it: null when there is none or they may not, alike. */
  entity: (entity: BrainEntityRef) => Promise<BrainEntityListed | null>;
  /** A page of what the Brain remembers about an entity that they may read, history included. */
  memories: (
    entity: BrainEntityRef,
    next?: BrainStoreCursor | null
  ) => Promise<BrainMemoryPage>;
  /** A page of the facts sources disagree on that they may read: their own store's first. */
  contested: (next?: BrainMemoryPageNext | null) => Promise<BrainContestedPage>;
  /** Confirms a current memory they may read, over the sides they may read that say otherwise. */
  confirm: (memory: BrainMemoryRef) => Promise<BrainMemoryOutcome>;
  /** Says a memory is wrong, with what is right: saved as their own word, for them alone, and confirmed. */
  correct: (correction: BrainCorrection) => Promise<BrainCorrected>;
}

/** What core answers a correction it can't take as it is. */
export const brainMemoryErrors = defineErrorFamily({
  "brain.correction_reused":
    "This correction was saved before with other words. Start it again.",
});
