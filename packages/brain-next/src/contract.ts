import { brainQuestionMaxLength } from "@grasp-os/shared/brain-sources";
import {
  instructionsMaxLength,
  isOverInstructionsLimit,
} from "@grasp-os/shared/instruction-files";
import { z } from "zod";

import type { BrainStore } from "./store.ts";
import { foldForSearch } from "./words.ts";

// The Brain's one way in. Its host (core) adds sources and recalls them
// through `Brain`, and nothing else reaches the store: its data lives in
// the store's own Durable Object, which only its own code can read.
//
// The Brain knows no people, teams or Apps. A source says who may read it
// as principals, opaque IDs the host names: a person, or a group. A
// recall names its reader the same way: the person, and every group the
// host counts them in now. The host decides both, from its own records,
// never from what a caller claims: so a group's membership is the host's,
// read at each recall, and a change in it rewrites nothing here.

/** Most bytes of a source's text (UTF-8), as given and as indexed. */
export const sourceTextMaxBytes = 1_000_000;

/** What a store has of a key (`Brain.keyState`). */
export type KeyState = "free" | "held" | "erased";

/**
 * What an add says that an erasure closed: to an erased source, whose key
 * is closed for good (erasure.ts). Said only to the producer that adds it,
 * which never retries it: the message alone, so a producer tells it from
 * any other failure by comparing it whole.
 */
export const erasedSource = "The Brain refused it: what this adds was erased";

/**
 * What an add to a removed source says (`Brain.removeSources`): it is out
 * of use for good, its key closed while its history is kept, and the add
 * is never tried again. Said only to the producer that adds it, which
 * compares it whole.
 */
export const removedSource = "The Brain refused it: what this adds was removed";

/**
 * What an add says whose change was added before with other text or
 * readers: nothing changed, and the version that change made stays. Said
 * only to the producer that adds it, which compares it whole.
 */
export const changeTaken =
  "The Brain refused it: this change was added before with other text or readers";

/**
 * What `addMemories` answers a change added before with other memories:
 * the message alone, so a caller tells it from any other failure by
 * comparing it whole (a host that lets a person retry by a change key
 * answers it as theirs to start again).
 */
export const changeReused =
  "The Brain refused it: this change was added before with other memories";

/**
 * What a person's own store erased whole answers an add, or any call that
 * would write: they were erased, for good, so the add is refused as
 * `erasedSource` is, and never tried again.
 */
export const storeErased = "The Brain refused it: this store was erased";

/**
 * What the shared store answers an add only one person may read (`owner`
 * access): a source, an instruction file or memories. That is kept only
 * in that person's own store (`personalBrainOf`), so the shared store
 * refuses it whoever calls, before it reads or writes anything. The
 * message alone, naming no one, so a host tells it from any other failure
 * by comparing it whole: for a host that routes by readers, it is a bug.
 */
export const onlyInOwnStore =
  "The Brain refused it: what only one person may read is kept in that person's own store";

/**
 * What an add with an expected current version (`NewInstructions.after`)
 * says when the source's current version is another by the time it would
 * write: nothing is written. The caller reads the source again and decides;
 * the message alone, compared whole, tells it from any other failure.
 */
export const staleVersion =
  "The Brain refused it: the current version is not the one expected";

/** Most characters of a question (the host's page holds to it too). */
export const questionMaxLength = brainQuestionMaxLength;

/** Most groups a reader can be in. */
export const readerGroupsMax = 1000;

/** Most characters of a principal's ID. */
export const principalMaxLength = 256;

/**
 * Most chunks each way of a recall ranks (words, exact): a pack holds at
 * most this many of each, fewer when its budget is spent.
 */
export const recallLimit = 10;

/**
 * Most chunks the exact way checks in code for each exact part: of those
 * the reader may read that hold all its words, the likeliest to hold it in
 * a row first (exact.ts `near`), then the shortest, then the newest. A
 * part with more such chunks is capped: what lies past them is unknown,
 * so that part, and only that one, is never reported not found. A capped
 * part can still be missed in a long chunk where its words first appear
 * apart, past 200 likelier ones; the words way still ranks that chunk.
 *
 * Measured on a laptop over 20,000 chunks that each hold every word asked,
 * for the slowest question the limits allow (eight quoted phrases of stop
 * words, 2,000 characters): p50 123 ms, max 132 ms; the same question
 * without its quotes, by the words way alone: p50 128 ms, max 133 ms. What costs
 * is reading the posting lists of up to 16 words that every chunk holds,
 * which the words way did before; the exact way adds no measurable time.
 */
export const exactCandidatesMax = 200;

/** Most tokens a pack may be asked to fill. */
export const recallBudgetMax = 32_000;

/** Most characters of a source's identity, and of a change's key. */
export const sourceIdMaxLength = 256;

/** Most sources one read of current versions names. */
export const currentReadMax = 10;

/** Most versions one check of which a reader may still read names. */
export const readableCheckMax = 500;

/**
 * A string as the Brain takes it: well-formed, no half of a surrogate pair
 * on its own. Every string the Brain hashes, compares or keeps as bytes is
 * one: encoding turns a lone half into U+FFFD, so two strings would become
 * one file, one key or one name, and what is read back would not be what
 * was given. Checked first, before anything encodes it; the host checks
 * with the same rule.
 */
export const wellFormedString = () =>
  z.string().refine((value) => value.isWellFormed(), {
    message: "Holds an unpaired surrogate",
    abort: true,
  });

export const principalSchema = wellFormedString()
  .min(1)
  .max(principalMaxLength);

const encoder = new TextEncoder();

/** `text`'s length in UTF-8 bytes. */
const byteLengthOf = (text: string): number => encoder.encode(text).byteLength;

/**
 * A source's identity, as the host names it (this upload, this chat): the
 * same for every version of it, so a new version of the same thing is
 * added under the same identity. The host keeps one producer's sources
 * apart from another's in how it names them.
 */
export const sourceIdSchema = wellFormedString().min(1).max(sourceIdMaxLength);
export type SourceId = z.infer<typeof sourceIdSchema>;

/**
 * The key of one change to a source, from its producer: an upstream
 * revision, a message id, or an id minted before the first try. Unique per
 * source: every retry of that change carries it.
 */
export const changeKeySchema = wellFormedString().min(1).max(sourceIdMaxLength);

/** A version of a source: 1 for its first, counting up. */
export const versionSchema = z.int().positive();

/**
 * Who may read a source: one person (`owner`: theirs alone, admins
 * included), a named group (`audience`), or nobody, when who may read it
 * isn't known (`none`).
 */
export const accessSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("owner"), person: principalSchema }),
  z.strictObject({ kind: z.literal("audience"), group: principalSchema }),
  z.strictObject({ kind: z.literal("none") }),
]);
export type Access = z.infer<typeof accessSchema>;

/** The classes of work, the first first: an item of a class runs before any of the next. */
export const workPriorities = [
  /** What someone just asked about. */
  "asked",
  /** What people upload on purpose. */
  "upload",
  /** Conversations, meetings and runs. */
  "conversation",
  /** Recent documents. */
  "recent",
  /** Old documents and archives, which may never reach the front. */
  "archive",
] as const;
export type WorkPriority = (typeof workPriorities)[number];

/**
 * Whose word a memory is: an internal person's (`person`, as the host
 * names them: the one who said it, or who confirmed it), an outside
 * party's (a customer's mail, a supplier's document), an agent's (`agent`,
 * as the host names it) or the system's.
 */
export const speakerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("internal"), person: principalSchema }),
  z.strictObject({ kind: z.literal("outside") }),
  z.strictObject({ kind: z.literal("agent"), agent: principalSchema }),
  z.strictObject({ kind: z.literal("system") }),
]);
export type Speaker = z.infer<typeof speakerSchema>;

/** Whether `timeZone` is a time zone the runtime knows (IANA, as `Intl` takes it). */
const isTimeZone = (timeZone: string): boolean => {
  try {
    // Throws a RangeError for a zone it doesn't know.
    return (
      new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone !==
      ""
    );
  } catch {
    return false;
  }
};

/**
 * Memories to draw from a version as it is added (extraction.ts): whose
 * words its text is (`speaker`, a `Speaker`: the host's to say, never a
 * model's), when they were said (`saidAt`), in which time zone their
 * relative dates count ("next Friday"), and which class of work the
 * drawing takes (`workPriorities`). A version added without it is kept
 * and found, and no memory is drawn from it. The text is one message's
 * own words: a thread is one version per message, its quoted or
 * forwarded history stripped by the host (core's `said`).
 */
export const extractSchema = z.strictObject({
  speaker: speakerSchema,
  // From 1970 on: the queue keeps it as milliseconds since then.
  saidAt: z.date().min(new Date(0)),
  timeZone: z.string().min(1).max(64).refine(isTimeZone, {
    message: "Is no time zone",
  }),
  priority: z.enum(workPriorities),
});
export type Extract = z.infer<typeof extractSchema>;

/**
 * Whether `text` is within a source's bound (`sourceTextMaxBytes`), as
 * given and as the word index takes it: folding can grow a text many
 * times (a compatibility form such as "ﷺ" is 3 bytes, and 33 folded), so
 * the bound holds for both. The one rule of it, which an add checks and a
 * host fits a text to before it adds.
 */
export const fitsSourceText = (text: string): boolean =>
  byteLengthOf(text) <= sourceTextMaxBytes &&
  byteLengthOf(foldForSearch(text)) <= sourceTextMaxBytes;

/** Something other than whitespace. */
const notBlank = /\S/u;

/**
 * Whether `text` is one a source can be: well-formed, and something other
 * than whitespace, which has no passage to keep or find. With
 * `fitsSourceText`, the store's whole rule for a source's text, which an
 * add checks and a host checks before it adds, so what fails it is
 * refused as what it is, never tried again.
 */
export const isSourceText = (text: unknown): text is string =>
  wellFormedString().safeParse(text).success && notBlank.test(String(text));

/**
 * A version of a source to add: which source, the change it is, its text,
 * who may read this version; in a person's own store alone, the group it
 * is erased with (`Brain.eraseSource` of the group's key): a key its own
 * key starts with, then "/", a source keeping the group of its first
 * version; and, to draw memories from it, whose words it is (`extract`).
 */
export const newSourceSchema = z.strictObject({
  source: sourceIdSchema,
  change: changeKeySchema,
  group: sourceIdSchema.optional(),
  text: wellFormedString()
    .refine((text) => isSourceText(text), {
      message: "Holds no text",
      abort: true,
    })
    .refine((text) => byteLengthOf(text) <= sourceTextMaxBytes, {
      message: `At most ${sourceTextMaxBytes} bytes`,
      abort: true,
    })
    .refine((text) => fitsSourceText(text), {
      message: `At most ${sourceTextMaxBytes} bytes as indexed`,
    }),
  access: accessSchema,
  extract: extractSchema.optional(),
  /**
   * Whether the source is a thread: one version per message, each holding
   * that message's own words alone (`extract`). Said with its first
   * version and kept for good, as its group: an add saying otherwise is
   * refused. A later version of a thread never puts out or ends what an
   * earlier one said (memories.ts); a document's current version puts out
   * a memory of an earlier one whose quote it no longer holds (quotes.ts).
   */
  thread: z.boolean().optional(),
  /**
   * When the producer read this text from where it lives, in milliseconds
   * since the epoch, if it read it: an add of a text read before the
   * source's current version was read writes nothing (`AddedVersion`'s
   * `newer`), so a late add of an older read never replaces a newer one,
   * whatever order the adds arrive in. A `newer` answer records nothing,
   * not even its change, so a retry of that change is judged afresh.
   */
  readAt: z.int().nonnegative().optional(),
});
export type NewSource = z.infer<typeof newSourceSchema>;

/**
 * An instruction file's text: at most `instructionsMaxLength` UTF-16
 * units (`.length`), the one rule for it, which the host checks with
 * too. It may be empty: an emptied file is a version of its own, and
 * its host loads nothing for it.
 */
export const instructionsTextSchema = wellFormedString()
  // Not zod's `max`, which counts code points.
  .refine((text) => !isOverInstructionsLimit(text), {
    message: `At most ${instructionsMaxLength} UTF-16 units`,
  });

/**
 * A version of an instruction file to add: a source whose text is
 * `instructionsTextSchema`'s. It is kept whole and versioned like any
 * source, but never cut into chunks or indexed, so recall never finds it:
 * it is read whole (`readCurrent`).
 */
// Neither a group nor when it was read: an instruction file is written by
// a person over the version they saw (`after`), never a read that a later
// one may hold off.
export const newInstructionsSchema = newSourceSchema
  .omit({ extract: true, group: true, readAt: true, thread: true })
  .extend({
    text: instructionsTextSchema,
    /**
     * The current version the caller saw, null for none yet: the add writes
     * only while it still is, checked in the transaction that writes, and
     * is refused with `staleVersion` otherwise. Given, the add always makes
     * a new version, even of the current text and readers, so every add
     * that lands moves the version. A change the store already has answers
     * with the version it made first, so a retry still adds nothing twice;
     * sent over a version at or past that one, it is no retry, and is
     * refused with `staleVersion`.
     * Left out, an add writes whatever is current, and current text and
     * readers make no new version.
     */
    after: versionSchema.nullable().optional(),
  });
export type NewInstructions = z.infer<typeof newInstructionsSchema>;

/**
 * Who reads, as the host resolves them now: the person, and each group the
 * host counts them in. No person (`null`) reads as the groups alone, so
 * no `owner` source matches: what the host's code recalls for someone
 * never holds what only they may read.
 */
export const readerSchema = z.strictObject({
  person: principalSchema.nullable(),
  groups: z.array(principalSchema).max(readerGroupsMax),
});
export type Reader = z.infer<typeof readerSchema>;

/**
 * A reader who acts as their person, as a change made in their name (a
 * memory they confirm) needs: never one with no person.
 */
export const personReaderSchema = readerSchema.extend({
  person: principalSchema,
});
export type PersonReader = z.infer<typeof personReaderSchema>;

/** Which model and build made a vector, as the host's embedder says. */
export const embedModelSchema = z.strictObject({
  name: wellFormedString().min(1).max(128),
  build: z.string().regex(/^[0-9a-f]{1,64}$/u),
});
export type EmbedModel = z.infer<typeof embedModelSchema>;

/**
 * The name the store keeps a model's vectors under: the model and its
 * build, so vectors of two builds are never compared.
 */
export const vectorModelNameOf = ({ name, build }: EmbedModel): string =>
  `${name}@${build}`;

/** Most dimensions of a vector. */
export const vectorDimensionsMax = 4096;

/** A vector: finite numbers, never all zero (it has no direction). */
const vectorSchema = z
  .array(z.number())
  .min(1)
  .max(vectorDimensionsMax)
  .refine((vector) => vector.some((value) => value !== 0), {
    message: "Is all zeros",
  });

/**
 * Why the host went ahead without the question's vector though it runs a
 * model: its embedder didn't answer in time (`timed_out`), failed
 * (`failed`) or refused the question (`refused`), or gave a vector the
 * store can't take (`unusable`). A host that runs no model has no reason
 * to give: that is no failure.
 */
export const withoutMeaningReasons = [
  "timed_out",
  "failed",
  "refused",
  "unusable",
] as const;
export type WithoutMeaningReason = (typeof withoutMeaningReasons)[number];

/** A memory's id: the store's own, for citing it and retiring it. */
export const memoryIdSchema = z.uuid();
export type MemoryId = z.infer<typeof memoryIdSchema>;

/**
 * A recall: a question, in the reader's words, the reader, how many tokens
 * the pack may hold (`tokensOf`), to read the past, the moment the
 * sources are read as of: what each was then, to the millisecond and
 * including it (for "on a day", the day's last millisecond); and, to
 * search by meaning too, the question's vector (`meaning`) by the host's
 * model and the build that made it. The store makes no outside call, so
 * the host embeds the question first; without a vector, and always as of
 * a moment, recall is by words and exact parts alone. A host whose model
 * gave no vector it could use says why (`withoutMeaning`), for staff to
 * count (`RecallOverview`); never with a vector, nor as of a moment,
 * when there was no vector to miss.
 *
 * `used`: when the reader last used each memory of this store they used,
 * as the host knows its own person's use (core: when recall last handed
 * it to them in their own chat), at or before the moment asked. Ranks
 * memories by freshness among equals (`FoundMemory.usedAt`), so one they
 * never use fades; it only orders, never finds, drops or reveals: a
 * memory the reader may not read, or that isn't there, is passed over
 * alike. Kept in no store. The reader's whole use, uncut: it is looked up
 * in memory for each memory a way judged, never read as rows, so a longer
 * list costs recall no more rows.
 */
export const recallRequestSchema = z
  .strictObject({
    question: wellFormedString().max(questionMaxLength),
    reader: readerSchema,
    budget: z.strictObject({ tokens: z.int().min(1).max(recallBudgetMax) }),
    asOf: z.date().optional(),
    used: z
      .array(
        z.strictObject({
          memory: memoryIdSchema,
          at: z.date(),
        })
      )
      .optional(),
    meaning: z
      .strictObject({ model: embedModelSchema, vector: vectorSchema })
      .optional(),
    withoutMeaning: z.enum(withoutMeaningReasons).optional(),
  })
  .refine(
    ({ meaning, withoutMeaning }) =>
      meaning === undefined || withoutMeaning === undefined,
    {
      message: "Gives a vector and why it has none",
      path: ["withoutMeaning"],
    }
  )
  .refine(
    ({ asOf, withoutMeaning }) =>
      asOf === undefined || withoutMeaning === undefined,
    {
      message: "Gives why it has no vector for a moment that takes none",
      path: ["withoutMeaning"],
    }
  );
export type RecallRequest = z.infer<typeof recallRequestSchema>;

/**
 * The ways recall searches by (`Brain.recall`): words (its stop words
 * included, over passages and memories), exact parts, the entities the
 * question names and their relations, and meaning.
 */
export const searchWays = ["words", "exact", "entities", "meaning"] as const;
export type SearchWay = (typeof searchWays)[number];

/**
 * One way of recall since the store started: how many recalls searched by
 * it (a way runs only when the question has something for it: telling
 * words, an exact part, or a vector, not as of a moment), how many of
 * those it failed (its search threw, which fails the recall).
 */
export interface WayCounts {
  recalls: number;
  failed: number;
}

/**
 * Recall as staff see it, since the store started (`since`): kept in
 * memory, so gone with the instance, as `stepsFailed`. Counts alone:
 * nothing of a question, a reader or what was found.
 */
export interface RecallOverview {
  since: Date;
  ways: Record<SearchWay, WayCounts>;
  /** Recalls the host made without the question's vector, by why. */
  withoutMeaning: Record<WithoutMeaningReason, number>;
}

/** A version of a source, as an add records it. */
export interface SourceVersionRef {
  source: SourceId;
  version: number;
}

/**
 * What an instruction file's add answers: the version it made or already
 * is, and when that version was added, the same on every repeat of its
 * change.
 */
export interface AddedInstructions extends SourceVersionRef {
  addedAt: Date;
}

/**
 * What an add answers: the version it made or already is, or, `newer`, the
 * source's current version, read later than the add's text (`readAt`):
 * then the add wrote nothing.
 */
export interface AddedVersion extends SourceVersionRef {
  newer?: true;
}

/**
 * How recall found a chunk: as the question wrote one of its IDs or
 * quoted phrases (`exact`); by its telling words in any form
 * (`words`); by its commonest words alone (`stop words`), which say
 * little: a chunk found so is no answer by itself; or by meaning alone
 * (`meaning`): its vector is near the question's and neither other way
 * listed it, so it may share no word with the question (one in another
 * language, say). A chunk several ways found says the first of these.
 */
export type FoundBy = "exact" | "words" | "stop words" | "meaning";

/**
 * An item of a pack: a passage of a version of a source, cited by the
 * source, the version and the passage's place in it (from 0, the same
 * for every read of that version), with its text: the part of the passage
 * that best answers the question, or the whole passage (`whole`) when the
 * budget allowed.
 */
export interface PackItem extends SourceVersionRef {
  position: number;
  text: string;
  whole: boolean;
  found: FoundBy;
  /**
   * When the version this is of was last read where it lives, in
   * milliseconds since the epoch: the latest of its producer's read times
   * (`NewSource.readAt`). Only for a source whose producer said when it
   * read it, such as what an agent read through a connection.
   */
  readAt?: number;
}

/**
 * What a recall found the reader may read, best first, within its budget
 * as `tokensOf` counts it;
 * the parts of the question no passage the reader may read holds
 * (`notFound`: its words, folded, and its IDs and quoted phrases as
 * written), and whether the budget left out or shortened any passage
 * found (`truncated`).
 */
export interface Pack {
  items: PackItem[];
  /**
   * The memories found, best first, by the same fused order as `items`
   * and from the same budget (contract.ts `PackMemory`).
   */
  memories: PackMemory[];
  /** The contested facts among `memories`, each with every side packed. */
  contested: PackContested[];
  notFound: string[];
  truncated: boolean;
}

/**
 * A passage one store found for a recall: its chunk's row in that store,
 * its citation and its text.
 */
export interface FoundPassage extends SourceVersionRef {
  row: number;
  position: number;
  text: string;
  /**
   * When the version this is of was last read where it lives, in
   * milliseconds since the epoch: the latest of its producer's read times
   * (`NewSource.readAt`). Only for a source whose producer said when it
   * read it, such as what an agent read through a connection.
   */
  readAt?: number;
}

/**
 * A passage with what the words and exact ways order by after their
 * counts: its length in characters (as the store's SQL counts them) and
 * when its version was added, in milliseconds.
 */
export interface OrderedPassage extends FoundPassage {
  length: number;
  addedAt: number;
}

/**
 * What one store found for a recall, before any pack is made of it
 * (`Brain.find`): each way's passages with what they are ordered by, so
 * the lists of several stores merge into the lists one store holding all
 * of them would have found (across.ts `packAcross`). Only what the reader
 * may read, as for `recall`.
 */
export interface Finding {
  /**
   * The passages holding the question's telling words, best first, at
   * most `recallLimit`, with how many of its telling words each holds in
   * any form, how many of its stop words, and how many telling words as
   * written.
   */
  words: (OrderedPassage & { words: number; stops: number; exact: number })[];
  /**
   * When the telling words found fewer than `recallLimit`: the passages
   * only its stop words find, best first, as many as were missing, with
   * how many of them each holds.
   */
  stopWords: (OrderedPassage & { stops: number })[];
  /** The telling terms, by index, that any passage the reader may read holds. */
  terms: number[];
  /**
   * The candidates for the question's exact parts: each passage among the
   * first `exactCandidatesMax` of a part (`parts`, by index), and those of
   * them whose word index holds it as a phrase (`nearParts`).
   */
  exact: (OrderedPassage & { parts: number[]; nearParts: number[] })[];
  /** The exact parts, by index, more than `exactCandidatesMax` passages may hold. */
  capped: number[];
  /**
   * The passages nearest the question's vector, nearest first, with their
   * cosine and when their version was added, which ties are ordered by.
   */
  meaning: (FoundPassage & { score: number; addedAt: number })[];
  /**
   * The memories found: by their statement's words, best first, at most
   * `recallLimit`; along the relations of the entities the question
   * names, nearest first, at most `recallLimit`; and the other current
   * sides of each contested one found.
   */
  memories: {
    words: FoundMemory[];
    entities: FoundMemory[];
    rivals: FoundMemory[];
  };
}

/** An ASCII letter or the space: a third of a token each (`tokensOf`). */
const thirdOfAToken = /[A-Za-z ]/u;

/**
 * The tokens `text` counts as in a pack's budget: an estimate, the
 * Brain's own, since it knows no model and makes no outside call. At or
 * above what today's tokenizers give prose in the five languages, and
 * numbers, amounts and IDs; single letters, random letter strings (keys,
 * base64) and rare scripts can count higher on a real tokenizer. A pack
 * never passes its budget as counted here.
 *
 * - An ASCII letter, or a space: a third of a token. A real tokenizer
 *   takes a word of prose, with the space before it, as one token or two:
 *   about four characters a token in English, three to four in Dutch,
 *   German, French and Spanish.
 * - Any other ASCII character (a digit, punctuation, a symbol, a newline
 *   or a tab): a whole token. Dates, amounts, IDs and invoice lines run at
 *   one token per one or two characters; a newline is often a token of
 *   its own. The space alone is cheaper, because a tokenizer joins it to
 *   the word after it.
 * - A character of two bytes in UTF-8 (an accented or Greek or Cyrillic
 *   letter): a token. One of three or four bytes (Chinese, Japanese, an
 *   emoji): a token per byte, as a tokenizer that falls back to bytes
 *   splits a rare one.
 *
 * Rounded up. Checked by hand against how byte-pair tokenizers of today's
 * models cut text (no tokenizer is a dependency): "The invoice is paid." is
 * 8 here and about 5 there; "INV-2024-0042: € 1.250,00" is 24 here and
 * about 15 there; "financiële" is 4 here and 3 there; "請求書" is 9 here
 * and 3 to 6 there.
 */
export const tokensOf = (text: string): number => {
  let thirds = 0;
  let whole = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 0x80) {
      if (thirdOfAToken.test(character)) {
        thirds += 1;
      } else {
        whole += 1;
      }
    } else if (point < 0x8_00) {
      whole += 1;
    } else if (point < 0x1_00_00) {
      whole += 3;
    } else {
      whole += 4;
    }
  }
  return Math.ceil(thirds / 3) + whole;
};

/**
 * The tokens an item takes of a pack's budget: its text and its citation
 * (source, version and place), each by `tokensOf`.
 */
export const packItemTokens = ({
  source,
  version,
  position,
  text,
}: PackItem): number =>
  tokensOf(text) + tokensOf(`${source} ${version} ${position}`);

/** A version to read whole, and who reads it. */
export const versionRequestSchema = z.strictObject({
  source: sourceIdSchema,
  version: versionSchema,
  reader: readerSchema,
});
export type VersionRequest = z.infer<typeof versionRequestSchema>;

/** A change of a source to look up, and who asks. */
export const changeRequestSchema = z.strictObject({
  source: sourceIdSchema,
  change: changeKeySchema,
  reader: readerSchema,
});
export type ChangeRequest = z.infer<typeof changeRequestSchema>;

/** Sources whose current versions to read whole, and who reads them. */
export const currentRequestSchema = z.strictObject({
  sources: z.array(sourceIdSchema).max(currentReadMax),
  reader: readerSchema,
});
export type CurrentRequest = z.infer<typeof currentRequestSchema>;

/** Most sources, or versions of one, a listing answers at a time. */
export const listPageMax = 50;

/** Most characters of a listed source's opening (`ListedSource`). */
export const openingMaxLength = 200;

/** Most key prefixes one listing of sources is limited to. */
export const listPrefixesMax = 16;

/**
 * Sources to list, and who reads them: those whose key starts with one of
 * `prefixes` (the host names its producers so), at most `limit` (at most
 * `listPageMax`, and that when left out), after `after`: the last item of
 * the page before, by its current version's time and its key.
 */
export const sourceListRequestSchema = z.strictObject({
  reader: readerSchema,
  prefixes: z
    .array(wellFormedString().min(1).max(sourceIdMaxLength))
    .min(1)
    .max(listPrefixesMax),
  after: z
    .strictObject({ addedAt: z.date(), source: sourceIdSchema })
    .optional(),
  limit: z.int().min(1).max(listPageMax).optional(),
});
export type SourceListRequest = z.infer<typeof sourceListRequestSchema>;

/**
 * A source, as a listing names it: its current version and when that was
 * added; the opening of its text (of its first passage, at most
 * `openingMaxLength` characters), for a title; whether it is the
 * reader's alone (listed by their own store: the shared store keeps
 * nothing one person alone may read); and how many of its versions the
 * reader may read.
 */
export interface ListedSource {
  source: SourceId;
  version: number;
  addedAt: Date;
  opening: string;
  personal: boolean;
  versions: number;
  /**
   * When its current version was last read where it lives: the latest of
   * its producer's read times (`NewSource.readAt`), for a source whose
   * producer said.
   */
  readAt?: Date;
}

/** A page of sources, and whether more follow it. */
export interface SourceList {
  sources: ListedSource[];
  more: boolean;
}

/**
 * Versions of a source to list, and who reads them: at most `limit` (at
 * most `listPageMax`, and that when left out), those numbered below
 * `before` when given.
 */
export const versionListRequestSchema = z.strictObject({
  source: sourceIdSchema,
  reader: readerSchema,
  before: versionSchema.optional(),
  limit: z.int().min(1).max(listPageMax).optional(),
});
export type VersionListRequest = z.infer<typeof versionListRequestSchema>;

/** A version of a source, as a listing names it. */
export interface ListedVersion {
  version: number;
  addedAt: Date;
}

/** A page of a source's versions, and whether more follow it. */
export interface VersionList {
  versions: ListedVersion[];
  more: boolean;
}

/** Versions to check a reader may still read, and who reads them. */
export const readableRequestSchema = z.strictObject({
  versions: z
    .array(z.strictObject({ source: sourceIdSchema, version: versionSchema }))
    .max(readableCheckMax),
  reader: readerSchema,
});
export type ReadableRequest = z.infer<typeof readableRequestSchema>;

/** A version of a source, whole: its original text, and when it was added. */
export interface SourceVersion extends SourceVersionRef {
  text: string;
  addedAt: Date;
}

/**
 * Which of the host's models a call asks for: its careful one, or its
 * quick one, cheaper, for a check (the host's model roles).
 */
export const modelRoles = ["careful", "quick"] as const;

/** Most characters of a model call's purpose, `brain.<kind>[.<step>]`: what the host's gateway takes. */
export { modelPurposeMaxLength as purposeMaxLength } from "@grasp-os/shared/models";
export type ModelRole = (typeof modelRoles)[number];

/**
 * A model call the Brain's background work asks its host to make, through
 * the host's model gateway: what the call is for (`brain.<kind of work>`,
 * and `.<step>` for a kind that makes calls of more than one kind), which
 * of its models, its instructions, its one message, and how long it may
 * take: what is left of its item's time, less a moment. The host cancels
 * the call when that is over, and says so (`timed_out`).
 */
export interface ModelRequest {
  /** At most {@link purposeMaxLength} characters. */
  purpose: string;
  role: ModelRole;
  system: string;
  input: string;
  timeoutMs: number;
}

/**
 * The context window, in tokens, of the models the Brain's work asks (the
 * smallest of them): what a piece of a source read at once is cut to
 * (extraction.ts). Null when the host doesn't know it: then a version is
 * read whole, and a model whose window it overflows refuses the call.
 */
export const contextTokensSchema = z.int().positive().nullable();

/** Most milliseconds a model call may be given: an item's longest time. */
export const modelTimeoutMaxMs = 4 * 60_000;

/** Most seconds a host may ask the queue to wait for its model. */
export const modelWaitMaxSeconds = 3600;

/**
 * Why the queue waits for its model: the provider limits calls
 * (`rate_limited`); the AI account needs someone (`account`: no model
 * set up, a key refused or revoked, out of credit); or the way to a model
 * doesn't work now (`unavailable`: the provider down or hanging, connect
 * or the host out of reach).
 */
export const modelTroubles = [
  "rate_limited",
  "account",
  "unavailable",
] as const;
export type ModelTrouble = (typeof modelTroubles)[number];

/**
 * What the host's model answered: its text, and the model that answered
 * (the host's name for it, as its gateway reports it, which an extracted
 * memory records); that it refused the call as it is (`refused`: the request itself) or that the call ran out of its time
 * (`timed_out`), which fail the item; or that the queue must pause, why,
 * and for how many seconds where the provider said, with no item's attempt
 * spent. A call that throws instead is taken for the host out of reach.
 */
export const modelReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("answer"),
    text: z.string(),
    model: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("refused") }),
  z.strictObject({ kind: z.literal("timed_out") }),
  z.strictObject({
    kind: z.literal("busy"),
    reason: z.enum(modelTroubles),
    /** What the provider asked, when it said. */
    retryAfterSeconds: z
      .number()
      .positive()
      .max(modelWaitMaxSeconds)
      .optional(),
  }),
]);
export type ModelReply = z.infer<typeof modelReplySchema>;

/** The host's model, as the Brain's background work asks it. */
export type AskModel = (request: ModelRequest) => Promise<ModelReply>;

/**
 * Why an item's attempt failed, as the queue keeps it: a code it controls,
 * never text from a handler or a provider, which could carry content.
 */
export const workErrors = {
  failed: "Its work failed.",
  timed_out: "It ran out of time.",
  interrupted: "The Brain's store stopped while it ran.",
  unknown_kind: "No work of its kind is defined.",
  invalid_payload: "What it carries isn't what its kind takes.",
  model_refused: "The model gateway refused its call.",
  invalid_request: "Its call to the model couldn't be sent as it was.",
  too_many_calls: "It asked the model more often than one attempt may.",
  unreadable: "What it works on can't be read.",
  erased: "What it works on was erased.",
  embedder_unavailable: "The embedder gave no vectors for it.",
  no_progress: "It asked to go on without having done any of its work.",
  invalid_answer: "The model's answer isn't what its work takes.",
  window_too_small:
    "The model's context window can't hold the work's instructions.",
  restoring:
    "The store is restoring an export, so it adds nothing until that is done: it is tried again.",
} as const;
export type WorkErrorCode = keyof typeof workErrors;

/**
 * Errors an item meets the same way on every attempt while the release
 * and the host's models stay as they are: a call the queue won't send
 * (`invalid_request`: its purpose, step, role or size, fixed by the code
 * and the item's payload), or a window too small for the work
 * (`window_too_small`: the window is the host's models'). Parked at the
 * first, never tried again within minutes; it comes back a day later, as
 * any parked item, when a release or the models may have changed.
 */
export const workErrorsParkedAtOnce: readonly WorkErrorCode[] = [
  "invalid_request",
  "window_too_small",
];

/** Items of one kind waiting in the queue. */
export interface WaitingWork {
  kind: string;
  count: number;
  /** When the one waiting longest was added. */
  oldestAddedAt: Date;
}

/**
 * An item parked after too many failures, and why it last failed. It comes
 * back by itself a day later, until it was parked three times (`final`).
 */
export interface ParkedWork {
  /** The queue's own id for it, never used twice: what a requeue names. */
  id: number;
  kind: string;
  key: string;
  attempts: number;
  error: WorkErrorCode;
  /** The error's fixed wording (`workErrors`). */
  message: string;
  parkedAt: Date;
  /** How many times it was parked. */
  parks: number;
  /** Parked for good: it no longer comes back by itself. */
  final: boolean;
}

/** Most parked items an overview lists. */
export const parkedListed = 100;

/**
 * The queue paused for its model: why, since when (with no answer since),
 * and until when it claims nothing.
 */
export interface WorkPause {
  reason: ModelTrouble;
  since: Date;
  until: Date;
}

/**
 * An item whose handler ran past its time and its grace, settled as timed
 * out, still running on its own: its kind and key wait until it ends, and
 * it holds a slot meanwhile.
 */
export interface OverdueWork {
  kind: string;
  key: string;
}

/** The work queue, as staff see it: what waits, what runs, what is parked. */
export interface WorkOverview {
  waiting: WaitingWork[];
  running: number;
  /** The latest parked first, at most `parkedListed`. */
  parked: ParkedWork[];
  /** How many items are parked in all. */
  parkedCount: number;
  /** Null while the model answers. */
  paused: WorkPause | null;
  /** Handlers still running past their time, holding their key and a slot. */
  overdue: OverdueWork[];
  /**
   * How many erasures are recorded and hidden but not yet erased to the
   * last row: the tick finishes them a batch at a time. A count of
   * erasures, never of what they hold.
   */
  erasing: number;
  /**
   * How many sources keep versions but have no current version, so no one
   * can read them: what a replay of the ledger after a restore can leave
   * when the older copy's current version was an erased person's own
   * (erasure.ts). A count, never which.
   */
  sourcesWithoutCurrent: number;
  /**
   * Whether the store keeps anything at all: a version of a source, or a
   * memory. False once erasures took all it held (their history included).
   */
  holding: boolean;
  /**
   * Whether the store answers: `through` once it has read its erasure
   * ledger through; otherwise it answers nothing but this overview, each
   * call refused with why, while a replay after a restore is under way
   * (`replaying`: each call applies one more step) or while the ledger
   * can't be read (`unreadable`: read again at most every 30 s).
   */
  ledgerReplay: "through" | "replaying" | "unreadable";
  /**
   * The tick's own steps before its queue, each with its last failure
   * since the store started: the writing of erasures' ledger entries,
   * cleared once a tick wrote every one (reading the ledger is
   * `ledgerReplay`'s); the erasure of what erasures
   * still hold, set when a version failed to delete, which goes behind the
   * others and is tried again, cleared once a batch deletes all it takes;
   * the sweep
   * of leftover files, cleared once a
   * later sweep reached R2 and had its answer (one with nothing due
   * clears nothing; sweeping waits a quarter of an hour after a failure),
   * the repack of vector codes, cleared once a later tick's repack
   * finishes (tried again next tick), and the rebuild of the word indexes
   * after their rules changed, cleared once a later batch finishes.
   */
  stepsFailed: {
    ledger: StepFailure | null;
    erase: StepFailure | null;
    sweep: StepFailure | null;
    repack: StepFailure | null;
    reindex: StepFailure | null;
    /**
     * The catch-up of quotes (catch-up.ts): judging the sources the adds
     * left unjudged. Cleared once a later tick's step runs through.
     */
    quotes: StepFailure | null;
    /**
     * The tick's step of embedding (embedding.ts): the walk onto the
     * queue, and removing a replaced build's codes. Cleared once a later
     * tick's step runs through.
     */
    embedding: StepFailure | null;
  };
  /** How far the host's embedding model has come over the current chunks. */
  embedding: EmbeddingOverview;
  /**
   * How many bytes the store's SQLite takes, from its page count, never a
   * scan: what `storeBytesMax` holds it to.
   */
  storeBytes: number;
  /**
   * Whether every chunk's words are indexed by the current rules, or a
   * rebuild is under way (`rebuildWords`, or new rules).
   */
  words: "current" | "rebuilding";
  /** The erasures the store applied, as its ledger keeps them. */
  erasures: ErasuresOverview;
  /** Recall by each way, since the store started. */
  recall: RecallOverview;
}

/**
 * The most bytes one Durable Object stores: 10 GB, read as 10^9 bytes a
 * GB, the lower reading. A store full to it fails every write.
 */
export const storeBytesMax = 10 * 1000 ** 3;

/**
 * What a staff action did: `done`; `nothing`, when there was nothing to do
 * (no item of that id parked, or a rebuild under way); `unavailable`, when
 * the store answers nothing yet, as it reads its erasure ledger, and so
 * applied nothing.
 */
export type StaffActionOutcome = "done" | "nothing" | "unavailable";

/** How many erasures are in the ledger, and how many not yet. */
export interface ErasureCount {
  written: number;
  unwritten: number;
}

/**
 * The erasures of sources the store applied, as counts only: written to
 * the ledger or not yet, and by reason. Never which, when, or the SHA-256 the
 * ledger names one by: an unsalted hash of an id confirms to anyone
 * holding the id that it was erased.
 */
export interface ErasuresOverview {
  source: ErasureCount;
  writer: ErasureCount;
  byReason: Record<ErasureReason, number>;
}

/**
 * The embedding of the current versions' chunks, by the host's model as
 * the store last saw it at a tick: counts only, never a passage.
 *
 * A replaced build goes in the background once the rebuild's walk is
 * over: its codes 16 blocks a tick (16,384 codes), its full vectors in the
 * bucket by the file sweep, at most 400 a tick (files.ts). So about
 * 300,000 vectors of a replaced build clear in roughly half a day at a
 * tick a minute; meanwhile they are never searched.
 */
export interface EmbeddingOverview {
  /** The model and its build (`vectorModelNameOf`); null while the host runs none, so nothing is embedded. */
  model: string | null;
  /** Chunks of current versions. */
  chunks: number;
  /** Of those, the ones with vectors of `model`. */
  embedded: number;
  /**
   * Of those, the ones `model` can't embed: the embedder's own answer for
   * the text (its module failed on it twice, it is too long, or not text).
   * Passed over until a re-embed or another build.
   */
  unembeddable: number;
  /** Items of embedding parked after too many failures. */
  parked: number;
  /**
   * Whether the rebuild for `model` is done: since the model last changed
   * or staff last asked for a re-embed, every current version was put on
   * the queue, and every item that put there has settled, none parked.
   * Then every chunk current when the rebuild began, and not replaced
   * since, has vectors of `model` or is counted in `unembeddable`; what
   * was added since may still wait, as `embedded` and `chunks` show. False
   * while the host runs no model. What recall may rely on (GRA-1769).
   */
  rebuilt: boolean;
}

/**
 * Most passages one embed request names: one batch of an item
 * (embedding.ts `embedBatch`), one call of the embedder.
 */
export const embedTextsMax = 16;

/**
 * Passages to embed, and how long the host may take for all of them:
 * what is left of the item's time.
 */
export interface EmbedRequest {
  texts: string[];
  timeoutMs: number;
}

/**
 * What the host's embedders answered, per passage, in order:
 * - its vector;
 * - `unembeddable`: the embedder's own answer that it can't embed that
 *   text (its module failed on it twice, or it is too long, or not text);
 * - null: not embedded this time (its call broke, or the time was up),
 *   which says nothing about the passage.
 * With the model and build that answered, vectors and verdicts alike
 * (null when none came): a verdict of another build than the host's is
 * not its own, and is kept no more than its vectors.
 * Or that the embedders gave nothing at all (`unavailable`), which fails
 * the item: they are the host's own objects, not a provider, so nothing
 * pauses.
 */
export const embedReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("vectors"),
    model: embedModelSchema.nullable(),
    results: z
      .array(
        z.union([z.array(z.number()), z.literal("unembeddable"), z.null()])
      )
      .max(embedTextsMax),
  }),
  z.strictObject({ kind: z.literal("unavailable") }),
]);
export type EmbedReply = z.infer<typeof embedReplySchema>;

/**
 * The host's embedders, as the Brain's work uses them: the model they run
 * now (null while none ships: nothing is embedded, and the overview says
 * so), and a way to embed passages with it.
 */
export interface Embedders {
  model: EmbedModel | null;
  embed: (request: EmbedRequest) => Promise<EmbedReply>;
}

// Hand-overs: what the host produces (a workflow run, say) reaches the
// Brain through its work queue, never in a call that adds it at once. The
// host puts a source's key on the queue (`handOver`); the item, as it
// runs, asks the host to hand that source over (`HandOvers.handOver`): the
// host reads it from its records then and adds it, through its own way
// of adding, which picks the store its readers belong in. A hand-over
// that fails is retried and, after too many failures, parked where staff
// see it.

/** The classes of work a hand-over may take (`workPriorities`). */
export const handOverPriorities = ["conversation"] as const;
export type HandOverPriority = (typeof handOverPriorities)[number];

/** Most sources one `handOver` puts on the queue. */
export const handOversMax = 100;

/** Sources to put on the queue, each with its class of work. */
export const handOverRequestSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        source: sourceIdSchema,
        priority: z.enum(handOverPriorities),
      })
    )
    .min(1)
    .max(handOversMax),
});
export type HandOverRequest = z.infer<typeof handOverRequestSchema>;

/**
 * Why a hand-over was refused for good: what it adds was erased (its key
 * is closed, or its one reader's erasure began), or removed (its key is
 * closed, its history kept: `Brain.removeSources`), the host's answer can't
 * be added (no readers, a text that isn't one), or its text is past a
 * source's bound with nothing smaller to keep.
 */
export const handOverRefusals = [
  "erased",
  "removed",
  "invalid",
  "too_large",
] as const;
export type HandOverRefusal = (typeof handOverRefusals)[number];

/**
 * How a hand-over ended, as the host says it: added as `version`, nothing
 * to add (the source is gone), or refused for good. Each settles the item
 * as done; only a throw tries it again.
 */
export const handOverResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("added"), version: z.int().positive() }),
  z.strictObject({ kind: z.literal("nothing") }),
  z.strictObject({
    kind: z.literal("refused"),
    reason: z.enum(handOverRefusals),
  }),
]);
export type HandOverResult = z.infer<typeof handOverResultSchema>;

/** The host's side of hand-overs, as the shared store's work uses it. */
export interface HandOvers {
  /**
   * Hands `source` over as the host's records hold it now, and says how
   * it ended (`HandOverResult`). Throws only for a failure worth trying
   * again (a store out of reach, an audit write that failed, the store
   * restoring an export): never refused for a restore, which would settle
   * it. Safe to repeat.
   */
  handOver: (source: SourceId) => Promise<HandOverResult>;
}

/**
 * One tick of a store (`Brain.work`): its time, the host's model calls and
 * embedders, and the host's side of hand-overs. Hand-overs are the shared
 * store's alone: the shared store's tick hands them over with these, and
 * a person's own store, which never queues one (`handOver` refuses), has
 * none to hand over whatever it is given.
 */
export interface WorkRequest {
  ask: AskModel;
  at: Date;
  embedders: Embedders;
  handOvers: HandOvers;
  /**
   * The context window of the models `ask` asks, in tokens (the smallest
   * of them): what extraction cuts a source's text to, a piece at a time
   * (`contextTokensSchema`). Null when the host doesn't know it.
   */
  contextTokens: number | null;
}

/**
 * A step of the tick that didn't finish: when, and why, as a code of the
 * store's own (R2 didn't answer in time, or the step failed), never an
 * error's text.
 */
export interface StepFailure {
  at: Date;
  reason: "timed_out" | "failed";
}

/**
 * Why something is erased, as the ledger keeps it: deleted for good by a
 * person or an admin (`deleted`), its retention over (`retention`), the
 * person erased by an admin (`person_erased`), or the person withdrew
 * (`withdrawn`, an interview, say).
 */
export const erasureReasons = [
  "deleted",
  "retention",
  "person_erased",
  "withdrawn",
] as const;
export type ErasureReason = (typeof erasureReasons)[number];

/**
 * What a person's own store answers an erasure of a source
 * (`Brain.eraseSource`): how many sources it covered, its key's and each
 * added in it as a group, that held a version as it was applied; a repeat
 * answers the same. None once the store was erased whole.
 */
export interface SourceErased {
  sources: number;
}

/** A source to erase, every version of it, and why. */
export const sourceErasureSchema = z.strictObject({
  source: sourceIdSchema,
  reason: z.enum(erasureReasons),
  /**
   * That the key is a group's (`NewSource.group`), though no add may have
   * named it yet: so it is erased as one, and keys under it are refused
   * from then on, named in the group or not. A key an add named as a
   * group is erased as one whether this is given or not. A person's own
   * store's alone: the shared store, which holds no group, ignores it.
   */
  asGroup: z.literal(true).optional(),
});
export type SourceErasure = z.infer<typeof sourceErasureSchema>;

/**
 * The most sources one removal takes (`Brain.removeSources`): its keys
 * are removed in one transaction, each a few indexed statements, so one
 * call's work stays small whatever a caller has to remove; a caller with
 * more sends a page after the other.
 */
export const removalsMax = 100;

/** Sources to take out of use, keeping their history (`Brain.removeSources`). */
export const sourceRemovalSchema = z.strictObject({
  sources: z.array(sourceIdSchema).min(1).max(removalsMax),
});
export type SourceRemoval = z.infer<typeof sourceRemovalSchema>;

/**
 * Whether `source` may be in `group`: its key is the group's, "/" and
 * more, so no source joins a group its key isn't under.
 */
export const isInGroup = (source: string, group: string): boolean =>
  source.length > group.length + 1 && source.startsWith(`${group}/`);

/** A person whose own store to erase whole, and why. */
export const personErasureSchema = z.strictObject({
  person: principalSchema,
  reason: z.enum(erasureReasons),
});
export type PersonErasure = z.infer<typeof personErasureSchema>;

/**
 * A writer whose memories to erase (`Brain.eraseWriter`): the host's code
 * as the App it runs (`app:<id>`), as an add names it, and why.
 */
export const writerErasureSchema = z.strictObject({
  writer: principalSchema,
  reason: z.enum(erasureReasons),
  /**
   * The caller's key for this erasure, the same on each of its retries
   * (one per store deletion, one per data reset): the same change answers
   * the erasure it made, and erases nothing more; another is another.
   */
  change: changeKeySchema,
});
export type WriterErasure = z.infer<typeof writerErasureSchema>;

/**
 * What an erasure of a writer's memories answers: when it was recorded,
 * and how many memories it covered then; the same on every repeat of its
 * change (`Brain.eraseWriter`).
 */
export interface WriterErased {
  erasedAt: Date;
  memories: number;
}

/**
 * What staff look up in the store's record of its erasure ledger: a
 * source, by its key, as it was erased. A person's erasure is no entry of
 * it: their own store is erased whole, and core keeps the record of that.
 */
export const erasureLookupSchema = z.strictObject({ source: sourceIdSchema });
export type ErasureLookup = z.infer<typeof erasureLookupSchema>;

/**
 * Whether what staff looked up was erased, and nothing else (no reason,
 * no count, no hash): `erased`, with when the ledger recorded the latest
 * erasure of it, once every erasure of it is written to the ledger and
 * this store's tick has deleted the versions it hid: hidden for good,
 * nothing can read it and a restore can't bring it back. Its files leave
 * the bucket in the background, after a 15-minute grace (files.ts), and
 * a person's own store deletes what it hid on its own tick: neither is
 * waited for. `erasing` until then; `not_erased` when the record holds no
 * erasure of it, alike whether it ever existed; `unavailable` while the
 * store reads its erasure ledger.
 */
export type ErasureStatus =
  | { state: "erased"; at: Date }
  | { state: "erasing" | "not_erased" | "unavailable" };

/**
 * What every refusal of the store starts with: a call refused for what it
 * asked, never a fault. A host answers one as such (a conflict), not as an
 * error of its own.
 */
export const refusalPrefix = "The Brain refused it:";

/**
 * What an add answers while a restore runs (restoring.ts): a refusal to
 * make again shortly, once the restore is done, as a producer makes an add
 * again after any failure.
 */
export const restoringNow = `${refusalPrefix} it is restoring an export, so it adds nothing until that is done: add it again shortly`;

/**
 * The keys of what is kept whole, never indexed: instruction files
 * (`instructions:`) and skills (`skill:`, core's skills, #2198), both added
 * with `addInstructions`. `addInstructions` takes only such keys and
 * `addSource` none, so nothing kept whole is ever indexed, and nothing
 * indexed is kept whole.
 */
export const wholeKeyPrefixes = ["instructions:", "skill:"] as const;

/** Whether `source` is a key of what is kept whole (`wholeKeyPrefixes`). */
export const isWholeKey = (source: string): boolean =>
  wholeKeyPrefixes.some((prefix) => source.startsWith(prefix));

/**
 * The keys of Grasp's own skills, shipped with each release (core's
 * `addShippedSkill`): never in an export, as each release adds them again.
 */
export const shippedSkillsPrefix = "skill:grasp:";

/**
 * The deployment an export is of, as the host names it: its manifest says
 * so, and a restore refuses another deployment's export.
 */
export const deploymentSchema = wellFormedString().min(1).max(256);

/** An export, by its id: random, made by the store. */
export const exportIdSchema = z.uuid();

/** An export to ask about. */
export const exportRequestSchema = z.strictObject({
  id: exportIdSchema,
});
export type ExportRequest = z.infer<typeof exportRequestSchema>;

/**
 * The name of part `index`'s file of an export (`jsonl`), or of what it
 * holds (`holds.json`): its number in four digits at least, more past
 * 9,999. The one rule of a part's name, for its writer and every reader
 * (`exportPartOf`): nothing sorts parts by their names.
 */
export const exportPartNameOf = (
  index: number,
  kind: "jsonl" | "holds.json"
): string => `part-${String(index).padStart(4, "0")}.${kind}`;

const exportPartPattern =
  /^part-(?<index>\d{4,})\.(?<kind>jsonl|holds\.json)$/u;

/**
 * The part a file's name says, and whether it is what the part holds:
 * only for a name in the writer's own form (`exportPartNameOf`), so no two
 * names are one part.
 */
export const exportPartOf = (
  name: string
): { index: number; holds: boolean } | undefined => {
  const groups = exportPartPattern.exec(name)?.groups;
  const kind = groups?.kind === "holds.json" ? "holds.json" : "jsonl";
  const index = Number(groups?.index);
  return groups !== undefined &&
    Number.isSafeInteger(index) &&
    exportPartNameOf(index, kind) === name
    ? { index, holds: kind === "holds.json" }
    : undefined;
};

/** An export's file a download asks for: its manifest, or one of its parts. */
export const exportFileNameSchema = z
  .string()
  .max(64)
  .refine(
    (name) => name === "manifest.json" || exportPartOf(name)?.holds === false,
    { message: "Not a file of an export" }
  );

/** A file of an export to read. */
export const exportFileRequestSchema = exportRequestSchema.extend({
  file: exportFileNameSchema,
});
export type ExportFileRequest = z.infer<typeof exportFileRequestSchema>;

/**
 * A person's own export, asked by that person: their store answers no one
 * else (store.ts).
 */
export const ownExportRequestSchema = z.strictObject({
  person: principalSchema,
});
export type OwnExportRequest = z.infer<typeof ownExportRequestSchema>;

/** A person's start of their own export, for `deployment`. */
export const ownExportStartSchema = ownExportRequestSchema.extend({
  deployment: deploymentSchema,
});
export type OwnExportStart = z.infer<typeof ownExportStartSchema>;

/** A file of a person's own export, asked by that person. */
export const ownExportFileRequestSchema = exportFileRequestSchema.extend({
  person: principalSchema,
});
export type OwnExportFileRequest = z.infer<typeof ownExportFileRequestSchema>;

/**
 * Where an export is: being written; adopted by a restore that hasn't yet
 * checked every part (`restoring`: served to no one); done, with its files (the manifest
 * first); failed (a file it was to read was gone: its files deleted);
 * erased, as the erasure ledger names a version it holds, and its files
 * are deleted; or expired, replaced by a newer one of its scope, its files
 * deleted. Start a new one.
 */
export interface ExportStatus {
  id: string;
  state: "writing" | "restoring" | "done" | "failed" | "erased" | "expired";
  /** Versions written so far. */
  versions: number;
  /** Its files, once done: none before. */
  files: string[];
}

/** Where a restore of a company export is, and how many versions it restored. */
export interface RestoreStatus {
  export: string;
  /**
   * Failed restores start again while the store holds nothing but what they
   * wrote, also once an erasure (of a source, a person, or a writer, as an
   * App's data reset) names what the export holds: started again, they
   * leave it out, and the export's files are kept meanwhile. Abandoned
   * once the store took something since (a version added, or a write of
   * memories: an add, a confirmation, a retire, an extraction mark), or
   * once its check found a part of the export damaged; by nothing else.
   */
  state: "running" | "done" | "failed" | "abandoned";
  restored: number;
}

/** Most vectors one put takes. */
export const vectorsPerPutMax = 256;

/** Most chunks one vector search returns. */
export const vectorSearchLimitMax = 50;

/** Most characters of a model's name. */
export const modelNameMaxLength = 256;

const modelNameSchema = wellFormedString().min(1).max(modelNameMaxLength);

/**
 * The embedding model vectors come from, as its caller names it: the
 * model and its build (`name`, one name per build, so codes of two builds
 * are never compared), and the centre its 1-bit codes are taken against,
 * shipped with the model: a vector's bit is set where it is above the
 * centre. The model's first vectors fix its centre and dimensions.
 */
export const vectorModelSchema = z.strictObject({
  name: modelNameSchema,
  centre: z.array(z.number()).min(1).max(vectorDimensionsMax),
});
export type VectorModel = z.infer<typeof vectorModelSchema>;

/** A chunk: its place in a version of a source, from 0. */
export const chunkRefSchema = z.strictObject({
  source: sourceIdSchema,
  version: versionSchema,
  position: z.int().nonnegative(),
});
export type ChunkRef = z.infer<typeof chunkRefSchema>;

/** Vectors of chunks to keep, from one model, each as long as its centre. */
export const vectorsToPutSchema = z
  .strictObject({
    model: vectorModelSchema,
    vectors: z
      .array(
        z.strictObject({
          chunk: chunkRefSchema,
          vector: vectorSchema,
          /**
           * The SHA-256 of the text the vector was made of: kept only if
           * the chunk still holds that text.
           */
          hash: z
            .string()
            .regex(/^[0-9a-f]{64}$/u)
            .optional(),
        })
      )
      .min(1)
      .max(vectorsPerPutMax),
  })
  .refine(
    ({ model, vectors }) =>
      vectors.every(({ vector }) => vector.length === model.centre.length),
    { message: "A vector is not as long as the model's centre" }
  );
export type VectorsToPut = z.infer<typeof vectorsToPutSchema>;

/** A search by meaning: a model's vector of the question, and the reader. */
export const vectorSearchSchema = z.strictObject({
  model: modelNameSchema,
  vector: vectorSchema,
  reader: readerSchema,
  limit: z.int().min(1).max(vectorSearchLimitMax),
});
export type VectorSearch = z.infer<typeof vectorSearchSchema>;

/** A chunk a vector search found, and how near it is: its cosine, -1 to 1. */
export interface FoundChunk extends ChunkRef {
  score: number;
}

/** What a vector search found the reader may read, nearest first. */
export interface VectorsFound {
  chunks: FoundChunk[];
}

// Memories and entities (memories.ts, entities.ts).
//
// A memory is a small dated statement drawn from a source or written by
// someone: what it is about (an entity, and an attribute from the fixed
// list of that entity's kind, `entityAttributes`), its two clocks (when it
// was true in the world: `validFrom`, `validUntil`; when the Brain
// learned it: `learnedAt`, and stopped believing it: `endedAt`), the quote
// it rests on and the source version it came from, whose word it is
// (`Speaker`), and who may read it. An entity is a thing memories are
// about: a person, a team, a customer and so on, with its names and exact
// identifiers. A relation between two entities is a memory about both
// (`object`).
//
// Never overwritten. Each memory has a lineage: the source it rests on
// (every version of it), or else the writer who wrote it. A newer memory
// of the same lineage about the same entity and one-value attribute ends
// the one before, which stays as history; a memory of another lineage
// that says something else makes the fact contested: both stay current
// and are read together, each with its source. A memory with no listed
// attribute never contests another, and ends only an earlier one of its
// lineage that it restates: the same statement as search folds text
// (case, accents, spacing and a final full stop aside, every sign kept),
// about the same entity, in the same speaker's word, of the same type,
// related entity and value. So the same fact said twice by one source or
// writer is one
// current memory, the earlier kept as history, merged only for readers of
// the later one.
// A memory resting on a version before its source's current one ends at
// that version's add when the current version no longer says its quote,
// word for word as search folds words, and is current again if a later
// version says it again; never for a thread (`NewSource.thread`) or a
// source kept whole (quotes.ts).
//
// Who may read a memory: those in the reader set its caller gives
// (`access`, as a source's), and, when it rests on a source version, only
// those among that version's readers and the source's current version's
// now, as `readVersion`. So the store never widens what its caller gave,
// and narrowing or erasing a source hides what was drawn from it. The
// caller's set must already be no wider than everything its model saw
// (extraction works in batches that share one set of readers): the store
// can check only the version a memory names. Every statement that reads,
// counts or ranks memories, entities or their names filters by the reader
// inside itself: an entity, and each of its names and identifiers, is
// visible only to a reader who can read a memory that mentions it with
// them.

/** The kinds of entity. */
export const entityKinds = [
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
export type EntityKind = (typeof entityKinds)[number];

/**
 * An attribute of a kind of entity: whether it holds one value (a newer
 * memory of the same lineage ends the one before; another lineage's
 * different value contests it) or many (each value stands beside the
 * others; a newer memory of the same lineage with the same value ends the
 * one before), and, for a relation, the kinds of entity its value is.
 */
export interface AttributeRule {
  readonly values: "one" | "many";
  readonly relation?: readonly EntityKind[];
}

/**
 * Every attribute a memory may be filed under, per kind of entity: the
 * fixed list. A memory about something not listed has no attribute
 * (`attribute` left out): it is kept and found, never contests another,
 * and ends only an earlier memory of its lineage it restates word for
 * word.
 */
export const entityAttributes = {
  person: {
    role: { values: "one" },
    team: { values: "many", relation: ["team"] },
    employer: { values: "one", relation: ["customer", "supplier"] },
    manager: { values: "one", relation: ["person"] },
    location: { values: "one" },
    language: { values: "many" },
    availability: { values: "one" },
    responsibility: { values: "many" },
    expertise: { values: "many" },
    owns: {
      values: "many",
      relation: [
        "customer",
        "supplier",
        "project",
        "product",
        "tool",
        "routine",
        "app",
        "workflow",
        "connection",
      ],
    },
    preference: { values: "many" },
    instruction: { values: "many" },
  },
  team: {
    purpose: { values: "one" },
    lead: { values: "one", relation: ["person"] },
    responsibility: { values: "many" },
    location: { values: "one" },
  },
  customer: {
    status: { values: "one" },
    renewal_date: { values: "one" },
    contract_value: { values: "one" },
    account_owner: { values: "one", relation: ["person"] },
    contact: { values: "many", relation: ["person"] },
    location: { values: "one" },
    industry: { values: "one" },
    requirement: { values: "many" },
    promise: { values: "many" },
    complaint: { values: "many" },
    next_step: { values: "many" },
  },
  supplier: {
    status: { values: "one" },
    contract_end: { values: "one" },
    terms: { values: "one" },
    account_owner: { values: "one", relation: ["person"] },
    contact: { values: "many", relation: ["person"] },
    supplies: { values: "many", relation: ["product", "tool"] },
    location: { values: "one" },
  },
  project: {
    status: { values: "one" },
    goal: { values: "one" },
    deadline: { values: "one" },
    owner: { values: "one", relation: ["person"] },
    member: { values: "many", relation: ["person", "team"] },
    customer: { values: "one", relation: ["customer"] },
    decision: { values: "many" },
    next_step: { values: "many" },
  },
  product: {
    description: { values: "one" },
    price: { values: "one" },
    status: { values: "one" },
    owner: { values: "one", relation: ["person", "team"] },
    feature: { values: "many" },
  },
  tool: {
    purpose: { values: "one" },
    owner: { values: "one", relation: ["person", "team"] },
    used_by: { values: "many", relation: ["person", "team"] },
    cost: { values: "one" },
  },
  routine: {
    purpose: { values: "one" },
    owner: { values: "one", relation: ["person", "team"] },
    frequency: { values: "one" },
    duration: { values: "one" },
    step: { values: "many" },
    variant: { values: "many" },
    wait: { values: "many" },
    evidence: { values: "one" },
    team: { values: "many", relation: ["team"] },
    uses: { values: "many", relation: ["tool", "app", "workflow"] },
  },
  app: {
    purpose: { values: "one" },
    owner: { values: "one", relation: ["person", "team"] },
    used_by: { values: "many", relation: ["person", "team"] },
  },
  workflow: {
    purpose: { values: "one" },
    owner: { values: "one", relation: ["person", "team"] },
    trigger: { values: "one" },
  },
  connection: {
    purpose: { values: "one" },
    owner: { values: "one", relation: ["person", "team"] },
  },
  term: {
    definition: { values: "one" },
    synonym: { values: "many" },
  },
} as const satisfies Record<EntityKind, Record<string, AttributeRule>>;

/** The attributes of the kind `K`. */
export type AttributeOf<K extends EntityKind> =
  keyof (typeof entityAttributes)[K] & string;

/** The rule of `attribute` for an entity of `kind`, or none when it isn't listed. */
export const attributeRuleOf = (
  kind: EntityKind,
  attribute: string
): AttributeRule | undefined => {
  const rules: Readonly<Record<string, AttributeRule>> = entityAttributes[kind];
  return Object.hasOwn(rules, attribute) ? rules[attribute] : undefined;
};

/**
 * What a memory says, as a kind: a fact, a decision, a preference or an
 * instruction. A preference or an instruction, by its type or by a
 * person's attribute of the name, is only ever an internal person's own
 * word, written by them (`isPersonsOwnWordOnly`): text in a document or a
 * mail never becomes one, which the store refuses.
 */
export const memoryTypes = [
  "fact",
  "decision",
  "preference",
  "instruction",
] as const;
export type MemoryType = (typeof memoryTypes)[number];

/** Most memories one add takes, and most entities. */
export const memoriesPerAddMax = 100;

/** Most names, and most identifiers, an entity of an add gives. */
export const namesPerEntityMax = 20;

/** Most characters of a memory's statement. */
export const statementMaxLength = 1000;

/** Most characters of a memory's quote. */
export const quoteMaxLength = 2000;

/** Most characters of a memory's value, and of an entity's name. */
export const valueMaxLength = 500;

/** Most memories, entities or contested facts one read answers. */
export const memoriesReadMax = 100;

/** An entity's id: the store's own, the same for every read. */
export const entityIdSchema = z.uuid();
export type EntityId = z.infer<typeof entityIdSchema>;

/**
 * An exact identifier of an entity: an email address (compared without
 * case), or a reference in some system (`ref`), written with that
 * system's name, as `crm:ACME-1` or, for the host's own records,
 * `grasp:app:<id>`, compared exactly. An identifier is evidence, never
 * access: who may read anything is the host's to say, never an email in
 * a memory.
 */
export const identifierSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("email"),
    value: wellFormedString()
      .min(3)
      .max(320)
      .regex(/^[^\s@]+@[^\s@]+$/u),
  }),
  z.strictObject({
    type: z.literal("ref"),
    value: wellFormedString()
      .min(3)
      .max(sourceIdMaxLength)
      .regex(/^\S+:\S+$/u),
  }),
]);
export type Identifier = z.infer<typeof identifierSchema>;

/**
 * A person to erase from the shared store (`Brain.erasePersonShared`):
 * the host's id for them, as it names them whose word a memory is or who
 * confirmed one, and the exact identifiers the host verified as theirs
 * (their sign-in email). A name is never one: only exact evidence says
 * which entity is theirs.
 */
export const sharedPersonErasureSchema = z.strictObject({
  person: principalSchema,
  identifiers: z.array(identifierSchema).max(namesPerEntityMax),
  reason: z.literal("person_erased"),
});
export type SharedPersonErasure = z.infer<typeof sharedPersonErasureSchema>;

/**
 * Who confirmed a memory (`Memory.confirmed.by`) once a person's erasure
 * took who it was (`Brain.erasePersonShared`): the confirmation stands, so
 * the memory doesn't turn contested because someone left, and no
 * principal is ever this.
 */
export const erasedConfirmer = "";

/** A short text a memory holds: some text, at most `max` characters. */
const someText = (max: number) =>
  wellFormedString().regex(/\S/u, { message: "Holds no text" }).max(max);

/**
 * A name of an entity: some text, at most `valueMaxLength` characters, and
 * no longer than that once folded as search folds it (`foldForSearch`:
 * compatibility forms such as "ﬃ" expand), so every name an add keeps
 * fits a `readEntityNames` cursor, which holds a name folded.
 */
export const nameSchema = someText(valueMaxLength).refine(
  (name) => foldForSearch(name).length <= valueMaxLength,
  { message: `At most ${valueMaxLength} characters once folded` }
);

/**
 * An entity an add names, by a key of its own within the add (`key`,
 * which its memories use): the known entity `id`, or else one found by
 * its exact identifiers, the first entity of its kind holding any of
 * them; or else, given no identifier, the one entity of its kind holding
 * one of its names of two words or more through memories read by exactly
 * the add's readers ("Cards and links" below); or else a new one.
 * Its names and identifiers are kept as given by each memory of the add
 * that mentions it, so each is visible only to those who can read such a
 * memory. Or the store's own entity (`own`, a `person` with no id, name
 * or identifier: "The store's own entity" below), made by the first add
 * that names it; the shared store refuses it.
 */
export const newEntitySchema = z
  .strictObject({
    key: wellFormedString().min(1).max(64),
    id: entityIdSchema.optional(),
    kind: z.enum(entityKinds),
    names: z.array(nameSchema).max(namesPerEntityMax).default([]),
    identifiers: z.array(identifierSchema).max(namesPerEntityMax).default([]),
    own: z.literal(true).optional(),
  })
  .refine(
    ({ own, id, kind, names, identifiers }) =>
      own === undefined ||
      (id === undefined &&
        kind === "person" &&
        names.length === 0 &&
        identifiers.length === 0),
    {
      message: "The own entity is a person named by nothing else",
      path: ["own"],
    }
  );
export type NewEntity = z.input<typeof newEntitySchema>;

/**
 * What a memory rests on: a version of a source in the same store, and
 * the quote of it the memory rests on (its lineage is the source); or a
 * writer (the person, agent or App writing it, as the host names them),
 * with what was said when there is a quote (its lineage is the writer).
 */
export const memoryBasisSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("source"),
    source: sourceIdSchema,
    version: versionSchema,
    quote: someText(quoteMaxLength),
  }),
  z.strictObject({
    kind: z.literal("writer"),
    writer: principalSchema,
    quote: someText(quoteMaxLength).optional(),
  }),
]);
export type MemoryBasis = z.infer<typeof memoryBasisSchema>;

/**
 * Whether a memory of `type`, filed under `attribute`, may only be an
 * internal person's own word: an instruction or a preference, by its type
 * or by its attribute (a person's `instruction` and `preference`). Such a
 * memory is taken only as written by that person themselves (a writer's
 * basis, the same person as its speaker): never drawn from a source, so
 * text in a document or a mail never becomes one, whoever it quotes.
 */
const isPersonsOwnWordOnly = (
  type: MemoryType,
  attribute: string | undefined
): boolean =>
  type === "instruction" ||
  type === "preference" ||
  attribute === "instruction" ||
  attribute === "preference";

/**
 * A memory to add: what it is about (an entity's key in the add), filed
 * under an attribute of that entity's kind, or none; for a relation, the
 * entity it relates to (`object`, required for a relation attribute,
 * allowed without an attribute); its value for an attribute that is not a
 * relation (what one-value attributes are compared by, folded as search
 * folds words); its type, statement, world clock (`validUntil` after
 * `validFrom`), whose word it is, and what it rests on.
 */
export const newMemorySchema = z
  .strictObject({
    about: wellFormedString().min(1).max(64),
    attribute: wellFormedString().min(1).max(64).optional(),
    object: wellFormedString().min(1).max(64).optional(),
    value: someText(valueMaxLength).optional(),
    type: z.enum(memoryTypes),
    statement: someText(statementMaxLength),
    validFrom: z.date().optional(),
    validUntil: z.date().optional(),
    speaker: speakerSchema,
    basis: memoryBasisSchema,
  })
  .refine(
    ({ validFrom, validUntil }) =>
      validFrom === undefined ||
      validUntil === undefined ||
      validUntil > validFrom,
    { message: "Ends before it starts", path: ["validUntil"] }
  )
  .refine(
    ({ type, attribute, speaker, basis }) =>
      !isPersonsOwnWordOnly(type, attribute) ||
      (basis.kind === "writer" &&
        speaker.kind === "internal" &&
        speaker.person === basis.writer),
    {
      message:
        "An instruction or preference is only an internal person's own word, written by them",
      path: ["type"],
    }
  );
export type NewMemory = z.infer<typeof newMemorySchema>;

/**
 * Memories to add in one call, with the entities they name, all readable
 * by the one set of readers `access` gives (no wider than everything the
 * model that drew them saw), under a change key: the same key again
 * answers what it added, whatever was added since, and is refused with
 * other memories. Every entity is mentioned by at least one memory.
 *
 * The change key is unique per change within the store, and comes from
 * the change's intent, never minted per attempt: for extraction, the
 * source, version and piece (one add per piece); for `remember`, the writer
 * and what they said. So a retry, from any caller, is the same change.
 *
 * `extracted` says a version of a source is fully extracted: every memory
 * drawn from an earlier version of that source ends then, as a newer
 * memory of its lineage ends it, for readers of the add (`access`) and of
 * that version (it must be one this store holds). With it, `memories` may
 * be empty.
 *
 * `reader` is who the add is made for, as the host resolved them: given,
 * an entity's `id` is taken only if they may see it; without it, only if
 * a memory with exactly `access`'s readers mentions it. Either way an id
 * that fails is refused in the words of an unknown one. It is not part of
 * the change: a repeat with another reader gets the first answer.
 *
 * An instruction (by type or by attribute) is only ever its writer's own:
 * its `access` must be `owner` of that writer. Shared with a group it
 * would steer colleagues' agents without the approved publish that shared
 * skills and instruction files need. A consumer presents one as an
 * instruction only in its writer's own chats and runs.
 */
export const newMemoriesSchema = z
  .strictObject({
    change: changeKeySchema,
    access: accessSchema,
    entities: z.array(newEntitySchema).max(memoriesPerAddMax),
    memories: z.array(newMemorySchema).max(memoriesPerAddMax),
    extracted: z
      .strictObject({ source: sourceIdSchema, version: versionSchema })
      .optional(),
    reader: readerSchema.optional(),
  })
  .refine(
    ({ memories, extracted }) => memories.length > 0 || extracted !== undefined,
    { message: "Adds no memory and marks no extraction", path: ["memories"] }
  )
  .refine(
    ({ access, memories }) =>
      memories.every(
        ({ type, attribute, basis }) =>
          (type !== "instruction" && attribute !== "instruction") ||
          (basis.kind === "writer" &&
            access.kind === "owner" &&
            access.person === basis.writer)
      ),
    {
      message: "An instruction is readable by its writer alone",
      path: ["access"],
    }
  );
export type NewMemories = z.input<typeof newMemoriesSchema>;

/** What an add made: each memory's id in the order given, and each entity's id by its key. */
export interface AddedMemories {
  memories: MemoryId[];
  entities: Record<string, EntityId>;
}

/**
 * A memory as a reader reads it. `endedAt` is when it stopped being
 * believed as this reader sees it: retired, or ended by a newer memory of
 * its lineage that the reader may read; null while current. `confirmed`
 * is a person's confirmation the reader may see: only one who can read
 * the memory and every memory it was confirmed over. `contested`: another
 * current memory the reader may read, of another lineage, says something
 * else for the same entity and one-value attribute.
 */
export interface Memory {
  id: MemoryId;
  about: EntityId;
  attribute: string | null;
  object: EntityId | null;
  value: string | null;
  type: MemoryType;
  statement: string;
  quote: string | null;
  /** The source version it rests on; null for a writer's. */
  source: SourceVersionRef | null;
  /** Who wrote it; null for one drawn from a source. */
  writer: string | null;
  speaker: Speaker;
  validFrom: Date | null;
  validUntil: Date | null;
  learnedAt: Date;
  endedAt: Date | null;
  /** `by` is `erasedConfirmer` once an erasure took who it was. */
  confirmed: { by: string; at: Date } | null;
  contested: boolean;
}

/**
 * Where a page of `readMemories` ended: the moment the first page was
 * read (`at`: its `asOf`, or then) and the moment what the store learned
 * was read at (`learned`: the earlier of that and the moment the read was
 * given; store-produced, passed back untouched, and never after `at`), at
 * which every later page is read too; and its last
 * memory's place in the order (its attribute, whether the reader saw it
 * confirmed, when it was learned, its id). The next page starts after it.
 */
export const memoriesCursorSchema = z
  .strictObject({
    at: z.date(),
    learned: z.date(),
    attribute: wellFormedString().min(1).max(64).nullable(),
    confirmed: z.boolean(),
    learnedAt: z.date(),
    memory: memoryIdSchema,
  })
  .refine(({ at, learned }) => learned.getTime() <= at.getTime(), {
    message: "Learned after the moment it reads at",
    path: ["learned"],
  });
export type MemoriesCursor = z.infer<typeof memoriesCursorSchema>;

/**
 * Memories about an entity to read, for a reader: those current now, or
 * as of a moment (believed then and true then, by both clocks); with
 * `history`, the ended ones too, `endedAt` and current both as of that
 * moment (ended by then, as seen then). Of one attribute only, if given:
 * one no kind lists, or that the entity's kind lacks, is refused (for an
 * entity the reader may not see, the answer is the empty page an unknown
 * id gets). A page of at most `limit` (a page size, at most
 * `memoriesReadMax`), after `after`.
 */
export const memoriesRequestSchema = z
  .strictObject({
    entity: entityIdSchema,
    reader: readerSchema,
    attribute: wellFormedString().min(1).max(64).optional(),
    asOf: z.date().optional(),
    history: z.boolean().optional(),
    after: memoriesCursorSchema.optional(),
    limit: z.int().min(1).max(memoriesReadMax).default(memoriesReadMax),
  })
  .refine(
    ({ asOf, after }) =>
      asOf === undefined ||
      after === undefined ||
      asOf.getTime() === after.at.getTime(),
    { message: "Reads as of another moment than its page", path: ["asOf"] }
  );
export type MemoriesRequest = z.input<typeof memoriesRequestSchema>;

/**
 * A page of the memories about an entity the reader may read (above), by
 * attribute (none last), then confirmed first, then the newest learned
 * first, then by id; whether more follow, and where to go on from.
 */
export interface MemoriesRead {
  memories: Memory[];
  more: boolean;
  next?: MemoriesCursor;
}

/**
 * Where a page of `listContested` ended: the moment the first page was
 * read (`at`), at which every later page is read too; and its last fact's
 * place (when its first memory the reader may read was learned, its
 * entity, its attribute).
 */
export const contestedCursorSchema = z.strictObject({
  at: z.date(),
  learnedAt: z.date(),
  entity: entityIdSchema,
  attribute: wellFormedString().min(1).max(64),
});
export type ContestedCursor = z.infer<typeof contestedCursorSchema>;

/**
 * Contested facts to list for a reader: about one entity, or any. A page
 * of at most `limit` facts, each whole, after `after`.
 */
export const contestedRequestSchema = z.strictObject({
  reader: readerSchema,
  entity: entityIdSchema.optional(),
  after: contestedCursorSchema.optional(),
  limit: z.int().min(1).max(memoriesReadMax).default(memoriesReadMax),
});
export type ContestedRequest = z.input<typeof contestedRequestSchema>;

/**
 * A page of contested facts, by when each fact's first memory the reader
 * may read was learned, then entity id, then attribute; whether more
 * follow, and where to go on from.
 */
export interface ContestedPage {
  facts: ContestedFact[];
  /** The moment the page was read at: what a fact's sides are read as of. */
  at: Date;
  more: boolean;
  next?: ContestedCursor;
}

/** Most sides of a contested fact a listing gives with it. */
export const factSidesShown = 10;

/**
 * A contested fact: an entity's one-value attribute for which the reader
 * may read current memories of more than one lineage saying different
 * things; its first `factSidesShown`, each with its source, in
 * `readMemories`' order (confirmed first, then the newest), and whether
 * more follow. All of them are `readMemories({ entity: about, attribute,
 * reader, asOf: page.at })`, paged as it pages, from the first again: for
 * a one-value attribute its current memories are exactly the sides.
 */
export interface ContestedFact {
  about: EntityId;
  attribute: string;
  memories: Memory[];
  more: boolean;
}

// What a version of a source changed (`readVersionChange`,
// version-change.ts): its change set, read from what the store keeps of
// it. Every add drawn from a source names the version it rests on
// (`SourceVersionRef`), so what a version added is the memories that rest
// on it; what it replaced is the earlier memories of its source's lineage
// that the first thing to end them, as the reader sees it, was a memory of
// it or its `extracted` mark; and what it made contested is what it added
// that stands contested. A memory that left only because a version's text
// no longer holds its quote is credited to no version: while a version is
// its source's current one, such memories are listed with it as no longer
// in the source (`out`), and with no other. All as of one moment, as
// `readMemories` reads with `history`, and only from what the reader may
// read: what they may not changes nothing in it.

/** The parts of a version's change, in the order a page gives them. */
export const versionChangeParts = ["added", "ended", "out"] as const;
export type VersionChangePart = (typeof versionChangeParts)[number];

/**
 * Where a page of `readVersionChange` ended: the moment the first page was
 * read (`at`), at which every later page is read too; and its last
 * memory's place (its part, when it was learned, its id).
 */
export const versionChangeCursorSchema = z.strictObject({
  at: z.date(),
  part: z.enum(versionChangeParts),
  learnedAt: z.date(),
  memory: memoryIdSchema,
});
export type VersionChangeCursor = z.infer<typeof versionChangeCursorSchema>;

/**
 * A version of a source whose change to read, for a reader: a page of at
 * most `limit` memories (a page size, at most `memoriesReadMax`), after
 * `after`.
 */
export const versionChangeRequestSchema = z.strictObject({
  source: sourceIdSchema,
  version: versionSchema,
  reader: readerSchema,
  after: versionChangeCursorSchema.optional(),
  limit: z.int().min(1).max(memoriesReadMax).default(memoriesReadMax),
});
export type VersionChangeRequest = z.input<typeof versionChangeRequestSchema>;

/**
 * A memory a version's change holds: one it added (current or, since,
 * history, as `readMemories` with `history` gives it), one it replaced
 * (`ended`), or, for the current version, one no longer in its text
 * (`out`).
 * One it added that stands contested comes with its current rivals the
 * reader may read: the first `factSidesShown`, and whether more follow.
 */
export interface ChangedMemory {
  part: VersionChangePart;
  memory: Memory;
  rivals: Memory[];
  moreRivals: boolean;
}

/**
 * An entity a page's memories name (about, or related to), as the reader
 * sees it; `firstSeen` when the first memory they may read that mentions
 * it (by when it was learned, then its id) is one the version added: an
 * entity the version made seen, not only linked to.
 */
export interface ChangedEntity extends Entity {
  firstSeen: boolean;
}

/**
 * A page of a version's change (above): what it added, then what it
 * replaced, then what is no longer in it, each by when it was learned,
 * then by id; the entities those
 * memories and their rivals name; the moment it was read at; whether
 * more follow, and where to go on from.
 */
export interface VersionChange {
  memories: ChangedMemory[];
  entities: ChangedEntity[];
  at: Date;
  more: boolean;
  next?: VersionChangeCursor;
}

/**
 * Memories to check a reader may still read, by id, and who reads them:
 * what a host checks before it sends again a memory it once recalled (a
 * chat's earlier recall).
 */
export const readableMemoriesRequestSchema = z.strictObject({
  memories: z.array(memoryIdSchema).max(readableCheckMax),
  reader: readerSchema,
});
export type ReadableMemoriesRequest = z.infer<
  typeof readableMemoriesRequestSchema
>;

/**
 * A memory to ask whether an erasure took it (`Brain.erasedOf`), with what
 * it rests on as a host read it when it was handed over: the key of the
 * source it was drawn from, or its writer, and when the store learned it;
 * whose word it is, and the entity it is about and the one it relates to
 * (a person's erasure takes a memory by those: people.ts). None of them
 * ever changes for a memory. What decides is the erasure ledger alone,
 * which outlives a lost storage: never whether the store holds the memory
 * now.
 */
export const erasedMemorySchema = z.strictObject({
  memory: memoryIdSchema,
  source: sourceIdSchema.nullable(),
  writer: principalSchema.nullable(),
  learnedAt: z.int().nonnegative(),
  speaker: speakerSchema,
  about: entityIdSchema,
  object: entityIdSchema.nullable(),
});
export type ErasedMemory = z.infer<typeof erasedMemorySchema>;

/**
 * Keys and memories to ask whether an erasure took them for good
 * (`Brain.erasedOf`): what a host once read itself.
 */
export const erasedRequestSchema = z.strictObject({
  sources: z.array(sourceIdSchema).max(readableCheckMax),
  memories: z.array(erasedMemorySchema).max(readableCheckMax),
});
export type ErasedRequest = z.infer<typeof erasedRequestSchema>;

/** Of what `erasedOf` was asked, what an erasure took for good. */
export interface Erased {
  sources: SourceId[];
  memories: MemoryId[];
}

/**
 * A memory of `writer`'s own to retire (its lineage is that writer's), that
 * the reader may read: a person forgetting their own word is both writer
 * and reader; the host's code writes as the App it runs (`app:<id>`), with
 * a reader of no person. The writer is the host's to decide, as an add's.
 */
export const retireRequestSchema = z.strictObject({
  memory: memoryIdSchema,
  reader: readerSchema,
  writer: principalSchema,
  /**
   * The caller's key for this retirement, the same on each of its retries
   * (an id minted per person and request, say): kept with the retirement,
   * so a repeat tells the call that retired the memory from another.
   */
  change: changeKeySchema,
});
export type RetireRequest = z.infer<typeof retireRequestSchema>;

/**
 * A retired memory: when it was retired and by which change, as recorded,
 * the same on every repeat, whoever repeats it. `change` is the stored
 * one: a call whose own change differs did not retire it. Null for one
 * retired before changes were kept.
 */
export interface RetiredMemory {
  retiredAt: Date;
  change: string | null;
}

/**
 * Where a page of `listWritten` ended: its last memory's learning time
 * and id. The next page starts after it.
 */
export const writtenCursorSchema = z.strictObject({
  learnedAt: z.date(),
  memory: memoryIdSchema,
});
export type WrittenCursor = z.infer<typeof writtenCursorSchema>;

/**
 * What `writer` wrote to list (`Brain.listWritten`), for `reader`, the
 * person the host resolved as that writer: a page of at most `limit`,
 * after `after`.
 */
export const writtenRequestSchema = z.strictObject({
  writer: principalSchema,
  reader: readerSchema,
  after: writtenCursorSchema.optional(),
  limit: z.int().min(1).max(memoriesReadMax).default(memoriesReadMax),
});
export type WrittenRequest = z.input<typeof writtenRequestSchema>;

/**
 * A memory its writer wrote and hasn't retired: its id, who may read it
 * (`Access`, null for readers the contract can't name), when it was
 * learned, and the memory as the reader reads it (`Memory`, ended ones
 * too), or null when they may not read it now: then nothing of what it
 * says.
 */
export interface WrittenMemory {
  id: MemoryId;
  access: Access | null;
  learnedAt: Date;
  memory: Memory | null;
}

/** A page of `listWritten`, by learning time then id; whether more follow, and where to go on from. */
export interface WrittenPage {
  memories: WrittenMemory[];
  more: boolean;
  next?: WrittenCursor;
}

/** A memory of `writer`'s own lineage to retire whoever may read it (`Brain.retireWritten`), under the caller's change. */
export const retireWrittenRequestSchema = z.strictObject({
  memory: memoryIdSchema,
  writer: principalSchema,
  change: changeKeySchema,
});
export type RetireWrittenRequest = z.infer<typeof retireWrittenRequestSchema>;

/** A memory the reader confirms, as their own word. */
export const confirmRequestSchema = z.strictObject({
  memory: memoryIdSchema,
  reader: personReaderSchema,
});
export type ConfirmRequest = z.infer<typeof confirmRequestSchema>;

/**
 * Where a page of `findEntities` ended: the moment the first page was
 * read (`at`), at which every later page is read too (a memory learned
 * since neither adds an entity to it nor moves one); and its last entity's
 * place (when its first memory the reader may read was learned, its id).
 */
export const entitiesCursorSchema = z.strictObject({
  at: z.date(),
  learnedAt: z.date(),
  entity: entityIdSchema,
});
export type EntitiesCursor = z.infer<typeof entitiesCursorSchema>;

/**
 * Entities to find for a reader: of a kind, holding an exact identifier,
 * or a name (compared folded, whole), any of them together; at least one.
 * A page of at most `limit`, after `after`.
 */
export const entitiesRequestSchema = z
  .strictObject({
    reader: readerSchema,
    kind: z.enum(entityKinds).optional(),
    identifier: identifierSchema.optional(),
    name: someText(valueMaxLength).optional(),
    after: entitiesCursorSchema.optional(),
    limit: z.int().min(1).max(memoriesReadMax).default(memoriesReadMax),
  })
  .refine(
    ({ kind, identifier, name }) =>
      kind !== undefined || identifier !== undefined || name !== undefined,
    { message: "Names no kind, identifier or name" }
  );
export type EntitiesRequest = z.input<typeof entitiesRequestSchema>;

/**
 * A page of entities, by when the first memory the reader may read that
 * mentions each was learned, then id; whether more follow, and where to
 * go on from. A memory its writer retired gives nothing to a find: no
 * mention, no name or identifier asked.
 */
export interface EntityPage {
  entities: Entity[];
  more: boolean;
  next?: EntitiesCursor;
  /**
   * Every version of a source what the page says rests on, each once:
   * for each entity, the first memory the reader may read that mentions
   * it (what makes it seen, and where it stands), the memory that gave
   * its name, and the earliest that gave each name or identifier asked;
   * and the first such memory of the entity past the page, which `more`
   * says follows. None for what rests on a writer's word. For the host
   * to keep with what it hands on (a run's pins); never shown to anyone.
   */
  restsOn: SourceVersionRef[];
  /**
   * Every memory in a writer's own word (no source) what the page says
   * rests on, by id, each once: of the same memories as `restsOn`, those
   * it has no version for. For the host to keep as `restsOn`.
   */
  restsOnWords: MemoryId[];
  /**
   * Every memory what it says rests on, the same as `restsOn` and
   * `restsOnWords` name, each once, with its record as `erasedOf` is
   * asked by it (`ErasedMemory`): its id, its source's key or writer, when
   * the store learned it, whose word it is, and its entities' ids. Each is
   * a memory the reader may read through this answer, so it tells no
   * reader anything they may not know; for the host to keep with what it
   * hands on (a run's pins), so what an erasure took of it is told by the
   * ledger alone (a person's erasure takes a memory by its speaker and
   * entities); never shown to anyone.
   */
  restsOnMemories: ErasedMemory[];
}

/** An entity to read, for a reader. */
export const entityRequestSchema = z.strictObject({
  entity: entityIdSchema,
  reader: readerSchema,
});
export type EntityRequest = z.infer<typeof entityRequestSchema>;

/**
 * An entity as a reader sees it: its kind, and its earliest name a memory
 * the reader may read, not retired by its writer, gave (by when that
 * memory was learned, then its id), or null when only retired memories
 * gave one. A retired memory stays history (`readMemories` with
 * `history`) and gives nothing else: an entity only retired memories
 * mention is not seen. Every name and identifier they may see is read a
 * page at a time (`readEntityNames`).
 */
export interface Entity {
  id: EntityId;
  kind: EntityKind;
  name: string | null;
}

/** A name or an exact identifier of an entity, as a memory gave it. */
export interface EntityName {
  type: "name" | "email" | "ref";
  value: string;
}

/**
 * Where a page of `readEntityNames` ended: the moment the first page was
 * read (`at`), at which every later page is read too; and its last name's
 * place (when the first memory the reader may read that gave it was
 * learned, that memory's id, its type and its folded form).
 */
export const entityNamesCursorSchema = z.strictObject({
  at: z.date(),
  learnedAt: z.date(),
  memory: memoryIdSchema,
  type: z.enum(["name", "email", "ref"]),
  // As a name's folded form is held to (`nameSchema`); identifiers fold to
  // no more than they are (an email lowercased, a reference as written).
  folded: wellFormedString().max(valueMaxLength),
});
export type EntityNamesCursor = z.infer<typeof entityNamesCursorSchema>;

/**
 * The names and identifiers of an entity to read, for a reader: a page of
 * at most `limit`, after `after`.
 */
export const entityNamesRequestSchema = z.strictObject({
  entity: entityIdSchema,
  reader: readerSchema,
  after: entityNamesCursorSchema.optional(),
  limit: z.int().min(1).max(memoriesReadMax).default(memoriesReadMax),
});
export type EntityNamesRequest = z.input<typeof entityNamesRequestSchema>;

/**
 * A page of every name and identifier of an entity a memory the reader
 * may read gave, each once, in the order of that first memory (learned,
 * then id), then type, then folded form; whether more follow, and where to
 * go on from. None for an entity the reader may not see, as for one no
 * one added.
 */
export interface EntityNamesPage {
  names: EntityName[];
  more: boolean;
  next?: EntityNamesCursor;
}

/**
 * What a change of a memory did: `done`, or `nothing`, alike when there
 * is no such memory, when the caller may not change it and when it was
 * no longer current.
 */
export type MemoryChangeOutcome = "done" | "nothing";

// Cards and links (cards.ts, linking.ts).
//
// An entity's card is a view, built for each reader when asked, from the
// memories that reader may read: never stored, so nothing has to be kept
// in step and nobody sees a line they shouldn't.
//
// An add links an entity on exact evidence (contract `NewEntity`): its
// known id, an exact identifier, or else an exact name, only where one
// entity of its kind alone holds that name through memories read by
// exactly the add's readers (so a link is never decided on what other
// readers hold). A likely match short of that is never a link: proposing
// one is GRA-1857's, joining two GRA-1835's.
//
// The order of adds decides a link. An entity given an identifier links
// by its identifiers alone; one given none links by its exact name. So
// "Jan de Vries" with an email, then "Jan de Vries" alone, are one
// entity; "Jan de Vries" alone first, then with the email, are two. Two
// entities of one add with the same name are not linked to each other by
// it, and a later add of that name, finding two holders, links to
// neither.
//
// A link, once made, stays; erasing the evidence does not undo it. Jan
// holds email x; a source says "Anna Smit" has email x, so her entity is
// Jan's (by the identifier); "Anna Smit" added without one then links to
// it by her name. Erasing the source leaves Anna's memories on Jan's
// card, and later adds of "Anna Smit" go on linking there. No reader sees
// more than they may read (the readers are the same), but the evidence
// for the join is gone, and nothing splits an entity.

// The store's own entity (own-entity.ts, store.ts `ownEntity`).
//
// A person's own store holds at most one entity that is its person: made
// fresh, of kind `person`, by the first add that names it as `own`, and
// never one a name or an identifier found, so no source, mail or model can
// make or choose it. The store is named by the person the host verified,
// and only the host adds to it, for them. It holds no name or identifier
// of its own, so linking by either never reaches it: an add names it only
// as `own`. An entity that holds the person's email is another entity.
// Kept while the store is (erasing its memories leaves it), and gone with
// the store erased whole. The shared store holds none, and refuses `own`.

/**
 * The reader's profile to read (store.ts `readProfile`), in their own
 * store, within `budget.tokens` (`packMemoryTokens` each).
 */
export const profileRequestSchema = z.strictObject({
  reader: personReaderSchema,
  budget: z.strictObject({ tokens: z.int().min(1).max(recallBudgetMax) }),
});
export type ProfileRequest = z.input<typeof profileRequestSchema>;

/**
 * What a chat starts with about its reader (the plan's profile): the
 * current memories about their own entity in their own word (an
 * `internal` speaker who is the reader), newest first (by when each was
 * learned, then by id), each whole, as many as fit the budget, stopping at
 * the first that doesn't. Built when asked, from what the reader may read,
 * never stored, so a changed or retired memory changes the next one.
 */
export interface Profile {
  memories: Memory[];
}

/** The reader's own entity to read, in their own store. */
export const ownEntityRequestSchema = z.strictObject({
  reader: personReaderSchema,
});
export type OwnEntityRequest = z.input<typeof ownEntityRequestSchema>;

/**
 * An entity's card to read, for a reader: as now, or as of a moment; a
 * page at a time, as `readMemories` pages the memories it is built from.
 */
export const cardRequestSchema = z.strictObject({
  entity: entityIdSchema,
  reader: readerSchema,
  asOf: z.date().optional(),
  after: memoriesCursorSchema.optional(),
  limit: z.int().min(1).max(memoriesReadMax).default(memoriesReadMax),
});
export type CardRequest = z.input<typeof cardRequestSchema>;

/**
 * An attribute of an entity on a card: its current memories the reader
 * may read (one, or several for an attribute of many values, or for a
 * contested one: each side with its source), and whether it is contested.
 */
export interface CardAttribute {
  attribute: string;
  memories: Memory[];
  contested: boolean;
}

/**
 * A relation on a card: a current memory relating the entity to another
 * (`other`, as the reader sees it), the entity being what the memory is
 * about (`about`) or what it relates to (`object`).
 */
export interface CardRelation {
  attribute: string | null;
  side: "about" | "object";
  other: Entity;
  memory: Memory;
}

/**
 * A page of an entity's card as a reader sees it: the entity, its
 * current values per attribute (`attributes`, in the order of the kind's
 * list), its relations, and its current memories filed under no
 * attribute (`notes`); all from a page of the memories the reader may
 * read about it, in `readMemories`' order; whether more follow, and
 * where to go on from. An attribute's values may go on in the next page.
 */
export interface Card {
  entity: Entity;
  attributes: CardAttribute[];
  relations: CardRelation[];
  notes: Memory[];
  more: boolean;
  next?: MemoriesCursor;
  /**
   * Every version of a source what the card says rests on, each once: its
   * memories'; the first memory the reader may read that mentions its
   * entity (what makes it seen); the memories that gave its entity's name
   * and each related one's; each contested memory's current rivals (what
   * makes it contested); the memories each counted confirmation was made
   * over (what makes one count); and the memory past the page, which
   * `more` says follows. None for what rests on a writer's word. For the
   * host to keep with what it hands on (a run's pins); never shown to
   * anyone.
   */
  restsOn: SourceVersionRef[];
  /**
   * Every memory in a writer's own word (no source) what the card says
   * rests on, by id, each once: of the same memories as `restsOn`, those
   * it has no version for. For the host to keep as `restsOn`.
   */
  restsOnWords: MemoryId[];
  /**
   * Every memory what it says rests on, the same as `restsOn` and
   * `restsOnWords` name, each once, with its record as `erasedOf` is
   * asked by it (`ErasedMemory`): its id, its source's key or writer, when
   * the store learned it, whose word it is, and its entities' ids. Each is
   * a memory the reader may read through this answer, so it tells no
   * reader anything they may not know; for the host to keep with what it
   * hands on (a run's pins), so what an erasure took of it is told by the
   * ledger alone (a person's erasure takes a memory by its speaker and
   * entities); never shown to anyone.
   */
  restsOnMemories: ErasedMemory[];
}

// Memories in a recall's pack (recall-memories.ts, pack.ts).

/**
 * How recall found a memory: by its statement's words (`words`), or along
 * the relations of an entity the question names (`entities`), at most two
 * steps; or as another side of a contested fact it found (`contested`).
 */
export type MemoryFoundBy = "words" | "entities" | "contested";

/**
 * A memory one store found for a recall, with what its way orders it by,
 * as the way's statement gave them; its passage
 * around its quote (`context`: the chunk of its version holding the
 * quote, or none), and for the entities way how many steps from an
 * entity the question names (0 to 2).
 */
export interface FoundMemory extends Memory {
  words: number;
  exact: number;
  step: number;
  /**
   * When the reader last used it, as the request said (`used`), or null:
   * with `learnedAt`, its freshness for them, which recall ranks by.
   */
  usedAt: Date | null;
  context: { position: number; text: string } | null;
}

/**
 * A memory in a pack: its stable id and what it is about, its statement,
 * its source (or writer) to cite, whose word it is, its dates; its quote
 * and the passage around it (`context`) when the budget allowed (null
 * otherwise, or when it has none), whether it is contested, and how it
 * was found.
 */
export interface PackMemory {
  memory: MemoryId;
  about: EntityId;
  attribute: string | null;
  object: EntityId | null;
  /**
   * What it says, as a kind. An instruction is in a pack only for its
   * writer, as their own (`writer` is the reader): a consumer presents it
   * as an instruction only in that person's own chats.
   */
  type: MemoryType;
  statement: string;
  quote: string | null;
  context: { position: number; text: string } | null;
  source: SourceVersionRef | null;
  writer: string | null;
  speaker: Speaker;
  validFrom: Date | null;
  validUntil: Date | null;
  learnedAt: Date;
  contested: boolean;
  confirmed: boolean;
  found: MemoryFoundBy;
}

/**
 * A contested fact in a pack: an entity's attribute for which the pack
 * holds current memories of more than one lineage saying different
 * things, by their ids, each in `memories`.
 */
export interface PackContested {
  about: EntityId;
  attribute: string;
  memories: MemoryId[];
}

/**
 * The tokens a memory takes of a pack's budget: its statement, quote and
 * context as held, and its citation (its id and source or writer).
 */
export const packMemoryTokens = ({
  memory,
  statement,
  quote,
  context,
  source,
  writer,
}: PackMemory): number =>
  tokensOf(statement) +
  tokensOf(quote ?? "") +
  tokensOf(context?.text ?? "") +
  tokensOf(
    `${memory} ${source === null ? (writer ?? "") : `${source.source} ${source.version}`}`
  );

/** The Brain, as its host calls it. */
export interface Brain {
  /**
   * Adds the change `source.change` to `source.source` as a version with
   * this text, readable as its access says, and makes it the source's
   * current one. In this order: a change added before answers with the
   * version it made, whatever was added since, and is refused with other
   * text or readers; a new change with the same text and readers as the
   * current version is that version. So an add is safe to repeat, late
   * or at once, after a lost reply or a crash.
   */
  addSource: (source: NewSource) => Promise<AddedVersion>;
  /**
   * Adds a version of an instruction file as `addSource` adds a source,
   * with the same versions, change keys and safe repeats, but kept whole:
   * never cut into chunks or indexed, so recall never returns it. The
   * shared store refuses one only one person may read (`owner`): it is
   * kept in that person's own store alone. With `after`, only over that
   * current version (null: none yet), checked in the writing transaction:
   * otherwise refused with `staleVersion`, nothing written; a change it
   * has answers with its version first. Answers when that version was
   * added too, so a repeat answers the time the first try made.
   */
  addInstructions: (source: NewInstructions) => Promise<AddedInstructions>;
  /**
   * A pack of what the reader may read for the question, within its
   * budget. Two ways search at once, each among the passages of the
   * versions the reader may read: words (those holding the question's
   * telling words in any of their forms, best first: more of them, then
   * more of its commonest words, the stop words of English, Dutch, German,
   * French and Spanish, then more of them as asked, then shorter, then
   * newer; passages holding only its commonest words after them, and only
   * when the others are fewer than the limit), and exact (for each of its
   * IDs and quoted phrases, the passages holding it as written, in
   * the words way's order, then shorter, then newer). Given the question's
   * vector (`meaning`), a third: the passages whose vectors of that model
   * and build are nearest it (as `searchVectors`, at most `recallLimit`);
   * none when the store holds no vectors of that build or the vector has
   * other dimensions than theirs, so a vector never fails a recall. The
   * lists are fused by rank and packed to the budget: each passage's best
   * part first, then whole passages. Meaning never makes a word found:
   * what was not found is the words way's and the exact way's alone.
   *
   * The versions searched are the current ones; as of a moment, each
   * source's version current then, only if the reader is among that
   * version's readers and among the current version's now (as
   * `readVersion`): so narrowing a source hides its past from recall too.
   * As of a moment, never by meaning, whatever vector is given: vectors
   * are kept for current versions only.
   * Nothing in a pack (its items, their order, what was not found, being
   * cut short) depends on what the reader may not read.
   */
  recall: (request: RecallRequest) => Promise<Pack>;
  /**
   * What `recall` finds, before it is packed: each way's passages with
   * what they are ordered by (`Finding`). A host recalling from several
   * stores asks each, with the same request, and packs them together
   * (across.ts `packAcross`): `recall` is that, over this store alone.
   */
  find: (request: RecallRequest) => Promise<Finding>;
  /**
   * What `find` finds of passages alone: no memory is read, so no memory
   * way runs, counts or can fail it (`memories` is empty). For a host
   * that hands on passages alone.
   */
  findPassages: (request: RecallRequest) => Promise<Finding>;
  /**
   * A version of a source, current or history, whole as it was added, for
   * a reader among that version's readers and the source's current
   * version's, with the groups the host counts them in now: `null` when
   * there is none or they may not, alike. So narrowing a source's readers
   * hides its history from those taken off.
   */
  readVersion: (request: VersionRequest) => Promise<SourceVersion | null>;
  /**
   * The version the change `change` of `source` made, by the rule
   * `readVersion` reads by: `null` when it made none, or the reader may
   * not read it, alike. Answers a number alone, never text: for a caller
   * whose reply to an add was lost, to learn whether the change landed
   * without sending it again.
   */
  changeVersion: (request: ChangeRequest) => Promise<number | null>;
  /**
   * The current version of each source asked for, whole, in the order
   * asked, leaving out alike each that doesn't exist and each whose
   * current version the reader may not read.
   */
  readCurrent: (request: CurrentRequest) => Promise<SourceVersion[]>;
  /**
   * What this store has of the key `source`, whoever may read it: `erased`
   * when an erasure closed it, `held` when a version of it is kept
   * (current or history) or it was removed (`removeSources`), `free` when
   * it was never given it. For the host
   * only, before it keeps a source in another store (one person's own):
   * a key lives in one store. A person's own store erased whole holds
   * nothing: `free`.
   */
  keyState: (source: SourceId) => Promise<KeyState>;
  /**
   * The sources whose current version the reader may read, among those
   * whose key starts with one of the prefixes asked: newest first by when
   * their current version was added, then by key, a page at a time. Each
   * counts only the versions the reader may read. What they may not read,
   * and what an erasure hid, is left out of everything a listing answers,
   * its order, its counts and whether more follow, as if it didn't exist.
   */
  listSources: (request: SourceListRequest) => Promise<SourceList>;
  /**
   * The versions of a source the reader may read (as `readVersion`
   * answers them: only while they may read its current version), newest
   * first, a page at a time; none, alike, for a source that doesn't
   * exist and one they may not read.
   */
  listVersions: (request: VersionListRequest) => Promise<VersionList>;
  /**
   * Of the versions asked for, those the reader may read now, as
   * `readVersion` decides it, in the order asked and each once, without
   * reading their text: what a host checks before it sends again what it
   * once read (a chat's earlier recall). Each left out alike, whether it
   * doesn't exist, was erased, or the reader may not read it.
   */
  readableVersions: (request: ReadableRequest) => Promise<SourceVersionRef[]>;
  /**
   * One tick of the host's clock, at `at`, the host's time now. First it
   * deletes one batch of what erasures hid and haven't deleted yet. Then
   * it removes one batch of what adds that never finished left (files no
   * version holds, once past the time an add takes). Then it repacks a few
   * blocks of vector codes that hold removed ones, and takes a step of
   * keeping the vectors to the host's embedding model (`embedders.model`):
   * versions still to embed onto the queue, a replaced build's vectors
   * removed. Then it works the queue: runs what is due, a few at a time,
   * asking `ask` for the model calls it makes and `embedders` for vectors,
   * and returns once what it started has ended and nothing more is due,
   * or its time to start more is up. `ask`, `embedders` and `handOvers`
   * (the host's side of hand-overs) are used only while this call is open.
   * A second tick at the same time shares the same limits and claims
   * nothing the first has under way.
   */
  work: (request: WorkRequest) => Promise<void>;
  /**
   * Puts each source on the work queue to be handed over (above), in
   * place of one of its hand-overs still waiting or parked. What the item
   * adds is whatever the host's `HandOvers.handOver` adds when it runs:
   * so putting a source on twice, or late, adds nothing twice and nothing
   * stale. The shared store's alone: a person's own store refuses it.
   */
  handOver: (request: HandOverRequest) => Promise<void>;
  /**
   * Starts the rebuild for the host's model again: every current version
   * with chunks it hasn't embedded goes on the queue again, those parked
   * for good among them, over the next ticks, and the passages it couldn't
   * embed are tried again. For staff: after the embedders were broken long
   * enough for items to park. Codes already there stay. During a walk, it
   * starts the walk over. `nothing` while no model was seen; `unavailable`,
   * changing nothing, while the store reads its erasure ledger.
   */
  reembed: () => Promise<StaffActionOutcome>;
  /** The queue, as staff see it. */
  workOverview: () => Promise<WorkOverview>;
  /**
   * Puts the parked item `id` back in the queue, due at once with its
   * attempts reset; its parks are kept, so one parked for good that fails
   * again is parked for good again. `nothing` when no item `id` is
   * parked; `unavailable`, changing nothing, while the store reads its
   * erasure ledger.
   */
  requeueWork: (id: number) => Promise<StaffActionOutcome>;
  /**
   * Starts a rebuild of the word indexes from every chunk's text, which
   * the tick works a batch at a time while recall goes on. `nothing` when
   * one is under way already, which goes on as it is; `unavailable`,
   * changing nothing, while the store reads its erasure ledger.
   */
  rebuildWords: () => Promise<StaffActionOutcome>;
  /**
   * Keeps each vector as the codes of its chunk for `model`, readable as
   * the chunk's version is. A chunk that is not of a current version is
   * left out, so a late put never brings back what a newer version
   * replaced. Codes are written once per chunk and model name: a chunk
   * that already holds codes for the model keeps them, so a put is safe
   * to repeat, and a wrong vector stays until the chunk's next version,
   * so a model's every build needs a name of its own. Refused when the
   * model's name is known with another centre. For the Brain's own work
   * queue (GRA-1768): the host has no way to it.
   */
  putVectors: (request: VectorsToPut) => Promise<void>;
  /**
   * The chunks of current versions the reader may read whose codes for
   * the model are nearest the vector, nearest first, none for a model
   * with no codes: an exact 1-bit scan of every such code, then the
   * nearest candidates re-scored by cosine, so a chunk near the top by
   * cosine whose 1-bit code is not among the candidates is missed. For
   * recall (GRA-1769): the host has no way to it.
   */
  searchVectors: (request: VectorSearch) => Promise<VectorsFound>;
  /**
   * Repacks one block of codes that holds removed ones, dropping them for
   * good: true when more are left. Harmless to run at any time or twice;
   * the store's own tick repacks a few blocks each time (`work`), and an
   * erasure repacks each block it removed codes from.
   */
  repackVectors: () => Promise<boolean>;
  /**
   * Erases a source for good: every version, its chunks and their words,
   * vector codes, change keys and queued work, the memories drawn from it
   * (hidden at once, deleted with their version) with any entity no other
   * memory mentions, and its files once no version holds them (the
   * sweep). Returns once the erasure is in the
   * ledger and nothing of the source is found or read any more; what is
   * left to delete, the store's tick finishes. The source's key is closed:
   * an add to it is refused from then on. Every source added in the key
   * as its group (`NewSource.group`) is erased with it, in the same one
   * entry. Once a key an add named as a group is erased, every key under
   * it (`<group>/…`) is refused and answers `erased` (`keyState`), named
   * in the group or not; a key no add named as a group closes alone, so
   * `upload:1` erased leaves `upload:1/x` free. Never an erasure by
   * prefix: what is erased is the key and its group's members. Safe to
   * repeat. The shared store answers nothing, alike whether the source
   * held anything; a person's own store, whose caller acts for that
   * person, answers how many sources the erasure covered, the same each
   * time it is repeated (`SourceErased`).
   */
  eraseSource: (request: SourceErasure) => Promise<SourceErased | undefined>;
  /**
   * Takes sources out of use for good and keeps their history (removal.ts),
   * up to `removalsMax` at once, all in one transaction: from when it
   * returns, nothing of them is found, listed or read by anyone, history
   * and memories drawn from them included, and nothing new is drawn from
   * them. Their versions, memories and files stay, and nothing is written
   * to the ledger. Each key is closed: an add to it, a retry of an earlier
   * change included, is refused (`removedSource`), and nothing puts it
   * back in use. An export holds them removed, and a restore brings them
   * back so. `eraseSource` still erases one for good. Covers each key's
   * own source alone, never a group's members. Safe to repeat, and
   * answers alike whatever there was.
   */
  removeSources: (request: SourceRemoval) => Promise<void>;
  /**
   * Erases `person`'s own store whole, the one place what only they may
   * read is kept: everything it holds, and from then on every call is
   * refused, also after a restore of its storage. Safe to repeat. A
   * person's own store alone, and only for that person: the shared store
   * holds nothing only one person may read (it refuses such an add), so it
   * refuses this.
   */
  erasePerson: (request: PersonErasure) => Promise<void>;
  /**
   * Erases every memory `writer` wrote (its lineage is the writer's),
   * learned up to now, retired ones too, as `eraseSource` erases a source:
   * recorded in the ledger and hidden from every read at once, deleted by
   * the tick if not by the call, with every name, entity, link and
   * confirmation that rests on them alone; a restore of an older copy or
   * of an export can't bring them back. Nothing else is touched: no
   * source, and no memory of anyone else, on the same entity or not. The
   * writer isn't closed: what it adds afterwards is new and kept. Answers
   * when it was recorded and how many memories it covered
   * (`WriterErased`); repeated with the same change, the same again and
   * nothing more erased, also after a restart or a restore, so a retry's
   * answer is the first one's. Another change is another erasure. Returns only
   * once the erasure is in the ledger: one that throws must be repeated.
   * The shared store's alone: a person's own store refuses.
   */
  eraseWriter: (request: WriterErasure) => Promise<WriterErased>;
  /**
   * Erases from the shared store what it derived about `person`, and what
   * is in their own word, for an erasure of the person (erasure.ts
   * `erasePersonShared`, people.ts): every memory whose speaker is them;
   * on an entity of kind `person` holding one of `identifiers`, their card,
   * every memory about it or relating to it, so it goes whole with its
   * names; on any other entity holding one of them, that identifier alone.
   * Hidden from every read at once, recorded in the ledger, deleted by the
   * tick if not by the call. Their confirmations stand, the confirmer
   * replaced by `erasedConfirmer`; every export started before it is
   * stale, when it changed anything. Their identifiers stay closed: a
   * write leaves one out and writes the rest, answering as for an
   * identifier held nowhere; what is drawn from a source (extraction, a
   * write resting on a version) also leaves out a person's card holding
   * one, with what is about it or relates to it, and their word. A restore
   * of an export (`startRestore`), before it writes any line and again on
   * every start, closes each `person` card the export gives with one, and
   * then passes over every line about it or relating to it, whichever
   * comes first, and every line in their word; another entity only loses
   * the identifier. Closed for good: nothing opens one again, also once
   * the host gives the address to someone else. The sources stay. Safe
   * to repeat: the same person is the same erasure, its identifiers those
   * of its first call. Refused while a restore runs (`restoringNow`), to
   * be asked again once it is through or given up; not held by one that
   * failed.
   * Returns only once its entry is in the ledger: one that throws must be
   * repeated. The shared store's alone: a person's own store refuses.
   */
  erasePersonShared: (request: SharedPersonErasure) => Promise<void>;
  /**
   * Whether a source was erased, from the store's record of its ledger
   * alone (`ErasureStatus`). For staff, who name what a client
   * gave them: it reads nothing but that record, so what was never erased
   * answers as what never existed. The shared store's alone: a person's
   * own store refuses, as it does `handOver` (staff's lookup reads a
   * person's own erasure from core's record of it, never from their store).
   */
  erasureStatus: (request: ErasureLookup) => Promise<ErasureStatus>;
  /**
   * Starts an export of the company's Brain for `deployment`, written by
   * the queue a part a run as files in the store's part of the bucket
   * (exports.ts): what the store holds as it starts, every version a group
   * may read, with its readers, current or history. While one is being
   * written, it answers with that one. A person's own store refuses.
   */
  startExport: (deployment: string) => Promise<{ id: string }>;
  /** Where an export is: null when there is none. */
  exportStatus: (request: ExportRequest) => Promise<ExportStatus | null>;
  /**
   * A file of a done export, as written: null for any other, alike, and
   * for one the ledger made stale.
   */
  exportFile: (request: ExportFileRequest) => Promise<string | null>;
  /**
   * Starts an export of what `person`'s own store holds, which only they
   * may read, by the company's rules (above), in their store's part of
   * the bucket: their sources and versions, memories, the entities and
   * names those give, confirmations, extraction marks and change keys.
   * Only their own store takes it, and only for them; erasing them deletes
   * it. While one is being written, it answers with that one. Nothing
   * restores it.
   */
  startOwnExport: (request: OwnExportStart) => Promise<{ id: string }>;
  /**
   * The export `person`'s own store shows them: their most recent one,
   * whatever came of it; null when there is none or the store was erased.
   * Only their own store answers, and only them.
   */
  ownExport: (request: OwnExportRequest) => Promise<ExportStatus | null>;
  /**
   * A file of `person`'s own done export, as `exportFile`: null for any
   * other, alike. Only their own store answers, and only them.
   */
  ownExportFile: (request: OwnExportFileRequest) => Promise<string | null>;
  /**
   * Starts restoring the company export `id` of `deployment` from the
   * bucket into this shared store, which must hold no version: a part a
   * run of the queue, every part checked against the manifest before any
   * is written, and each version left out when the erasure ledger names
   * it. Nothing is added to the store while it runs. Answers with the
   * restore of that export when one was started already; a failed one
   * starts again.
   */
  startRestore: (id: string, deployment: string) => Promise<RestoreStatus>;
  /**
   * Whether a restore of the company export `id` of `deployment` may start
   * now, starting nothing: throws as `startRestore` refuses. So the host
   * can prepare the store first.
   */
  checkRestore: (id: string, deployment: string) => Promise<void>;
  /** Where the restore of export `id` is: null when none was started. */
  restoreStatus: (id: string) => Promise<RestoreStatus | null>;
  /**
   * Adds memories and the entities they name, in one transaction, all
   * readable by `access` (above). Each entity is the known `id` (as
   * `reader` may see it), else the first of its kind holding one of its
   * identifiers by a memory with exactly `access`'s readers, else new. Each
   * memory of a one-value attribute ends the current one of its lineage
   * about the same entity and attribute (a source's: one from an earlier
   * version, or the same; a writer's: one added before); one from an
   * earlier version than a memory already there is kept, as history from
   * the start. Refused, adding nothing, when an entity key is unknown or
   * unmentioned, an attribute isn't its kind's, a relation lacks its
   * object or names one of another kind, a value is missing or given to a
   * relation, a source version isn't one this store holds (erased ones
   * included), a person's own store is given anyone else's readers, or the
   * change was added before with other memories. An identifier a person's
   * erasure closed is left out (`erasePersonShared`); when the add is
   * drawn from a source, so is that person's card with what is about it
   * or relates to it, which the answer then doesn't name. The same change
   * again answers what it added.
   */
  addMemories: (memories: NewMemories) => Promise<AddedMemories>;
  /**
   * A page of the memories about an entity the reader may read
   * (`MemoriesRead`).
   *
   * Pages of one read are read at one moment: a memory write after the
   * first page (an add, a confirmation, a retire, an extraction mark) is on
   * none of its later pages, and nothing is repeated, skipped or shown
   * current that was ended, while who may read the sources is unchanged.
   * Who may read a source is not held to that moment: a change to it
   * applies at once, so a page after it can repeat an item or skip one.
   * Dedupe pages by id. Nothing the reader may not read is ever returned.
   */
  readMemories: (request: MemoriesRequest) => Promise<MemoriesRead>;
  /**
   * The contested facts the reader may read, those of the entity given or
   * any: never one only memories hidden from the reader would contest.
   *
   * Pages of one read are read at one moment: a memory write after the
   * first page (an add, a confirmation, a retire, an extraction mark) is on
   * none of its later pages, and nothing is repeated, skipped or shown
   * current that was ended, while who may read the sources is unchanged.
   * Who may read a source is not held to that moment: a change to it
   * applies at once, so a page after it can repeat an item or skip one.
   * Dedupe pages by id. Nothing the reader may not read is ever returned.
   */
  listContested: (request: ContestedRequest) => Promise<ContestedPage>;
  /**
   * A page of what a version of a source changed, as the reader sees it
   * (`VersionChange`); null alike when the version doesn't exist, when
   * they may not read it or its source's current version, and when an
   * erasure hides it, as `readVersion` answers.
   *
   * Pages of one read are read at one moment, as `readMemories`' are: a
   * memory write after the first page is on none of its later pages,
   * while who may read the sources is unchanged. Dedupe pages by id.
   * Nothing the reader may not read is ever returned.
   */
  readVersionChange: (
    request: VersionChangeRequest
  ) => Promise<VersionChange | null>;
  /**
   * Of the memories asked for, by id, those the reader may read now (as
   * `readMemories` decides who may read one) and their writer has not
   * retired, in the order asked and each once: what a host checks before
   * it sends again a memory it once recalled (a chat's earlier recall).
   * Each left out alike, whether it doesn't exist, was erased, rests on a
   * version the reader may no longer read, or was retired. One ended by a
   * newer memory of its lineage, or whose time is over, stays: as a
   * source's older version stays readable once a newer one is added.
   */
  readableMemories: (request: ReadableMemoriesRequest) => Promise<MemoryId[]>;
  /**
   * Of the keys and memories asked, those an erasure took for good, as
   * the erasure ledger alone says it, whoever may read them, in the order
   * asked and each once: a key as `keyState` answers `erased`; a memory
   * whose source's key is so erased, whose writer was erased after the
   * store learned it (`eraseWriter`), or that a person's erasure takes
   * (`erasePersonShared`): in that person's word, or about or relating to
   * an entity it closed (their card). Never a retired memory, a key whose
   * readers only changed, nor a memory only because the store doesn't
   * hold it now: a lost storage, until a restore puts it back, lacks what
   * was never erased. For the host only, which asks of what it once read
   * itself, to replace what a chat showed of it. Ids alone, never text or
   * readers. A person's own store erased whole answers all of it; a store
   * restoring an export refuses (`restoringNow`).
   */
  erasedOf: (request: ErasedRequest) => Promise<Erased>;
  /**
   * Retires one of the writer's own memories (its lineage is the writer's,
   * `RetireRequest`) that the reader may read and that is not retired:
   * current, or ended by a newer one of the writer's. It stops being
   * current from now on, or can never become current again, and stays as
   * history. It no longer ends older memories, which may become current
   * again unless retired too. Answers when it was retired and by which
   * change, as recorded (`RetiredMemory`): one this writer already retired
   * answers that same time and change again, whatever change the call
   * names, and changes nothing, so a retry never reads as not found nor
   * gets a new time, and a call that didn't retire it can tell by the
   * change.
   * Null alike when there is no such memory, when it is another writer's
   * (retired or not), when the reader may not read it, and when it
   * expired before it was retired: nothing tells another writer's memory
   * from one there isn't. One this writer retired that expired afterwards
   * still answers its time on a repeat.
   */
  retireMemory: (request: RetireRequest) => Promise<RetiredMemory | null>;
  /**
   * A page of what `writer` wrote (its lineage is the writer's) and hasn't
   * retired, by when it was learned: each with who may read it and when
   * it was learned, and the memory itself only where the reader may read
   * it now; of any other, nothing of what it says. Never one an erasure
   * hides. For the host only, for a person listing their own word
   * (core's shares of a memory), the writer and the reader both that
   * person, as the host verified them: the store can't tell.
   */
  listWritten: (request: WrittenRequest) => Promise<WrittenPage>;
  /**
   * Retires one of `writer`'s own memories whoever may read it, as
   * `retireMemory` retires one, expired or not: its writer taking back
   * their own word, which removes and reads nothing. Answers when and by
   * which change (`RetiredMemory`), the same again for one this writer
   * retired before. Null alike for no such memory, another writer's, and
   * one an erasure hides. For the host only, the writer as the host
   * verified them.
   */
  retireWritten: (
    request: RetireWrittenRequest
  ) => Promise<RetiredMemory | null>;
  /**
   * The reader confirms a current memory they may read, over the current
   * memories of other lineages they may read that say something else of
   * the same entity and attribute: recorded as the reader's own word,
   * and read first among them by a reader who may read the memory and
   * each one it was confirmed over, and no current rival besides. A
   * repeat by the same person over the same rivals records nothing new.
   */
  confirmMemory: (request: ConfirmRequest) => Promise<MemoryChangeOutcome>;
  /**
   * The entities the reader may see that match, in the order of the first
   * memory they may read that mentions each.
   *
   * Pages of one read are read at one moment: a memory write after the
   * first page (an add, a confirmation, a retire, an extraction mark) is on
   * none of its later pages, and nothing is repeated, skipped or shown
   * current that was ended, while who may read the sources is unchanged.
   * Who may read a source is not held to that moment: a change to it
   * applies at once, so a page after it can repeat an item or skip one.
   * Dedupe pages by entity id. Nothing the reader may not read is ever returned.
   */
  findEntities: (request: EntitiesRequest) => Promise<EntityPage>;
  /**
   * A page of the names and identifiers of an entity the reader may see
   * (`EntityNamesPage`).
   *
   * Pages of one read are read at one moment: a memory write after the
   * first page (an add, a confirmation, a retire, an extraction mark) is on
   * none of its later pages, and nothing is repeated, skipped or shown
   * current that was ended, while who may read the sources is unchanged.
   * Who may read a source is not held to that moment: a change to it
   * applies at once, so a page after it can repeat an item or skip one.
   * Dedupe pages by type and value. Nothing the reader may not read is ever returned.
   */
  readEntityNames: (request: EntityNamesRequest) => Promise<EntityNamesPage>;
  /** An entity, if the reader may see it; null alike when there is none. */
  readEntity: (request: EntityRequest) => Promise<Entity | null>;
  /**
   * The id of the reader's own entity ("The store's own entity"), in their
   * own store; null until an add names it, and once the store is erased
   * whole. Only for that store's person; the shared store refuses.
   */
  ownEntity: (request: OwnEntityRequest) => Promise<EntityId | null>;
  /**
   * The reader's profile (`Profile`), in their own store, built now: empty
   * while they have no own entity, and once the store is erased whole.
   * Only for that store's person; the shared store refuses.
   */
  readProfile: (request: ProfileRequest) => Promise<Profile>;
  /**
   * An entity's card as the reader sees it (`Card`), built now from the
   * memories they may read: null when they may see no such entity, alike
   * for one nobody holds; with `asOf`, null too when no memory they may
   * read mentioned it by then.
   */
  readCard: (request: CardRequest) => Promise<Card | null>;
}

/** The shared store's name: everything readable by more than one person. */
const storeName = "brain";

/** What a person's own store's name starts with; the rest is their id. */
const personalPrefix = "person:";

/** Whose a store is, by its name: shared, one person's own, or unknown. */
export type StoreKind =
  | { kind: "shared" }
  | { kind: "person"; person: string }
  | { kind: "unknown" };

/**
 * How long an add may take between noting a file and recording its
 * version (files.ts), and the grace a whole-store erasure waits from its
 * record's moment before it is done (store.ts `#eraseWhole`).
 */
export const fileGraceMs = 15 * 60 * 1000;

/**
 * How long a person's own store may answer that it is still deleting
 * before its host counts the erasure as stuck: two graces (the second after
 * it moved its moment for a write that never answered) and an item's time
 * of the queue (`modelTimeoutMaxMs`, work.ts `workItemTimeMs`) more.
 */
export const stillDeletingAtMostMs = 2 * fileGraceMs + modelTimeoutMaxMs;

/**
 * What erasing a person's own store whole answers while it is still
 * deleting: its record written and its storage gone, its files waiting
 * out the time an add under way has to write one. The expected answer
 * for a while after every such erasure, not a failure: the host keeps the
 * erasure pending and calls again (`isStillDeleting`).
 */
export const stillDeleting =
  "The Brain erased this store and is still deleting its files: erase it again";

/** Whether `error` is the answer `stillDeleting`, as it crosses RPC. */
export const isStillDeleting = (error: unknown): boolean =>
  error instanceof Error && error.message === stillDeleting;

/**
 * Whose the store named `name` is. A name is all a store knows of itself
 * (store.ts), so this is the one rule of which store is whose, and it
 * fails closed: exactly `brain` is the shared store; `person:` followed
 * by a well-formed id is that person's own store; any other name (a
 * different case, a space, another separator, an id that isn't one), or
 * no name at all (an id not made from a name), is no one's, and refuses
 * every call. So a mistyped name never makes a second shared store,
 * sharing the shared store's part of the bucket, nor keeps private
 * content where it isn't guarded.
 */
export const storeKindOf = (name: string | undefined): StoreKind => {
  if (name === storeName) {
    return { kind: "shared" };
  }
  if (name === undefined || !name.startsWith(personalPrefix)) {
    return { kind: "unknown" };
  }
  const person = principalSchema.safeParse(name.slice(personalPrefix.length));
  return person.success
    ? { kind: "person", person: person.data }
    : { kind: "unknown" };
};

/**
 * The Brain's shared store, in `store`, the host's namespace of
 * `BrainStore`, in the jurisdiction the host keeps its objects in: what
 * more than one person may read.
 */
export const brainOf = (store: DurableObjectNamespace<BrainStore>): Brain =>
  store.getByName(storeName);

/**
 * `person`'s own store, in `store` as `brainOf`'s: what only they may
 * read. It answers them alone and keeps nothing anyone else may read
 * (store.ts). For the host only, with the person it has just verified:
 * whoever names it reaches that person's own content.
 */
export const personalBrainOf = (
  store: DurableObjectNamespace<BrainStore>,
  person: string
): Brain =>
  store.getByName(`${personalPrefix}${principalSchema.parse(person)}`);
