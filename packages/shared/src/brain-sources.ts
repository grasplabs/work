// The Brain's sources as a person reads them on the Brain's Sources page
// (`session.brainSources`): the sources they may read, a page at a time;
// one source's versions and text; and search, which is recall itself for
// that person: the pack as recall answers it, nothing ranked again. Core
// answers each from what the person may read alone, as if nothing else
// existed.

import { defineErrorFamily } from "./errors.ts";

/**
 * Who added a source: an upload, a chat, a workflow run, or what an agent
 * fetched through a connection (`capture`).
 */
export type BrainSourceProducer = "upload" | "chat" | "run" | "capture";

/** A source, as its producer names it. */
export interface BrainSourceRef {
  producer: BrainSourceProducer;
  id: string;
}

/**
 * A source the person may read: its current version and when that was
 * added (ISO 8601), its first line as its text gives it (empty when it
 * opens with none), whether it is theirs alone (nobody else sees it,
 * admins included), and how many of its versions they may read.
 */
export interface BrainSourceListed {
  source: BrainSourceRef;
  version: number;
  addedAt: string;
  firstLine: string;
  personal: boolean;
  versions: number;
}

/** Where the next page of sources starts: after this one. */
export interface BrainSourcesAfter {
  addedAt: string;
  source: BrainSourceRef;
}

/** A page of sources, newest first, and where the next starts: null at the last. */
export interface BrainSourcePage {
  sources: BrainSourceListed[];
  next: BrainSourcesAfter | null;
}

/** A page of a source's versions, newest first, and the version the next starts below. */
export interface BrainSourceVersionPage {
  versions: { version: number; addedAt: string }[];
  before: number | null;
}

/** A version of a source, whole. */
export interface BrainSourceText {
  source: BrainSourceRef;
  version: number;
  addedAt: string;
  text: string;
}

/**
 * How recall found a passage: as the question wrote it (`exact`), by its
 * words, by its commonest words alone (`stop words`), or by meaning alone.
 */
export type BrainFoundBy = "exact" | "words" | "stop words" | "meaning";

/** A passage of a pack: where it is, its text, and how it was found. */
export interface BrainSearchItem {
  source: BrainSourceRef;
  version: number;
  /** Its place in the version, from 0. */
  position: number;
  text: string;
  /** Whether `text` is the whole passage, not its best part. */
  whole: boolean;
  found: BrainFoundBy;
}

/**
 * How recall found a memory: by its words, along the entities the
 * question names, or as another side of a contested fact it found.
 */
export type BrainMemoryFoundBy = "words" | "entities" | "contested";

/**
 * A memory of a pack: the Brain's store it is in (the person's own, theirs
 * alone, or the shared one) and that store's id for it; what it says; the
 * words of its source it rests on and the passage around them, when the
 * pack holds them; where it came from: a source's version, or whose word
 * it is (`said`: the person's own, another person's, an agent's or a
 * system's; null for one drawn from a source); whether a person confirmed
 * it, whether sources disagree on it, and how it was found.
 */
export interface BrainSearchMemory {
  store: "own" | "shared";
  id: string;
  statement: string;
  quote: string | null;
  context: { position: number; text: string } | null;
  source: { source: BrainSourceRef; version: number } | null;
  said: "you" | "someone" | "agent" | "system" | null;
  confirmed: boolean;
  contested: boolean;
  found: BrainMemoryFoundBy;
}

/**
 * What a search found, as recall packs it: the passages and the memories,
 * each best first (a contested memory with every other side of its fact
 * right after it, or none of them); the parts of the question nothing the
 * person may read holds; and whether the budget left something out.
 */
export interface BrainSearchPack {
  items: BrainSearchItem[];
  memories: BrainSearchMemory[];
  notFound: string[];
  truncated: boolean;
}

/**
 * The first line of `text` that holds something, trimmed: a source's
 * title, as its listing and its page show it. Empty when none does.
 */
export const firstLineOf = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

/** Most characters of a question: the Brain's own limit, which the search box holds to too. */
export const brainQuestionMaxLength = 2000;

/** How many tokens a search's pack may hold (the Brain's own estimate). */
export const brainSearchBudget = 4000;

/** The Brain's sources, for the person signed in. */
export interface BrainSourcesApi {
  /** A page of the sources they may read, newest first, after `after`. */
  list: (after?: BrainSourcesAfter | null) => Promise<BrainSourcePage>;
  /** A page of a source's versions they may read, newest first, below `before`. */
  versions: (
    source: BrainSourceRef,
    before?: number
  ) => Promise<BrainSourceVersionPage>;
  /** A version of a source, whole: null when there is none or they may not read it, alike. */
  read: (
    source: BrainSourceRef,
    version: number
  ) => Promise<BrainSourceText | null>;
  /** Recall for `question` as them, within `brainSearchBudget` tokens. */
  search: (question: string) => Promise<BrainSearchPack>;
}

/**
 * Why core's Brain refused a call: a producer's add an erasure closed
 * (final, never retried), or an argument that isn't of the kind the call
 * takes.
 */
export const brainSourceErrors = defineErrorFamily({
  "brain.source_erased":
    "What this adds was erased: it stays erased, and isn't added.",
  "brain.request_invalid": "That isn't a valid request to the Brain.",
});
