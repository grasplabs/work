import { brainQuestionMaxLength } from "@grasp-os/shared/brain-sources";
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
 * is closed for good, or for a person alone that began before that
 * person's erasure (erasure.ts). Said only to the producer that adds it,
 * which never retries it: the message alone, so a producer tells it from
 * any other failure by comparing it whole.
 */
export const erasedSource = "The Brain refused it: what this adds was erased";

/**
 * What a person's own store erased whole answers an add, or any call that
 * would write: they were erased, for good, so the add is refused as
 * `erasedSource` is, and never tried again.
 */
export const storeErased = "The Brain refused it: this store was erased";

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

/**
 * Most UTF-16 units (`.length`) of an instruction file's text: about 2000
 * tokens, so the few files a chat starts with leave it room for the
 * conversation.
 */
export const instructionsMaxLength = 8000;

/** Most sources one read of current versions names. */
export const currentReadMax = 10;

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

const principalSchema = wellFormedString().min(1).max(principalMaxLength);

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

/**
 * A version of a source to add: which source, the change it is, its text,
 * and who may read this version.
 */
export const newSourceSchema = z.strictObject({
  source: sourceIdSchema,
  change: changeKeySchema,
  text: wellFormedString()
    // A text of whitespace alone has no passage to keep or find.
    .regex(/\S/u, { message: "Holds no text" })
    .refine((text) => byteLengthOf(text) <= sourceTextMaxBytes, {
      message: `At most ${sourceTextMaxBytes} bytes`,
      abort: true,
    })
    .refine((text) => fitsSourceText(text), {
      message: `At most ${sourceTextMaxBytes} bytes as indexed`,
    }),
  access: accessSchema,
});
export type NewSource = z.infer<typeof newSourceSchema>;

/** Whether `text` is over `instructionsMaxLength` UTF-16 units. */
export const isOverInstructionsLimit = (text: string): boolean =>
  text.length > instructionsMaxLength;

/**
 * An instruction file's text: some text, at most `instructionsMaxLength`
 * UTF-16 units (`.length`), the one rule for it, which the host checks
 * with too.
 */
export const instructionsTextSchema = wellFormedString()
  .regex(/\S/u, { message: "Holds no text" })
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
export const newInstructionsSchema = newSourceSchema.extend({
  text: instructionsTextSchema,
});
export type NewInstructions = z.infer<typeof newInstructionsSchema>;

/**
 * Who reads, as the host resolves them now: the person, and each group the
 * host counts them in.
 */
export const readerSchema = z.strictObject({
  person: principalSchema,
  groups: z.array(principalSchema).max(readerGroupsMax),
});
export type Reader = z.infer<typeof readerSchema>;

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
 */
export const recallRequestSchema = z
  .strictObject({
    question: wellFormedString().max(questionMaxLength),
    reader: readerSchema,
    budget: z.strictObject({ tokens: z.int().min(1).max(recallBudgetMax) }),
    asOf: z.date().optional(),
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
 * included), exact parts and meaning.
 */
export const searchWays = ["words", "exact", "meaning"] as const;
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
 * reader's alone (its current version's readers are that one person); and
 * how many of its versions the reader may read.
 */
export interface ListedSource {
  source: SourceId;
  version: number;
  addedAt: Date;
  opening: string;
  personal: boolean;
  versions: number;
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

/** A version of a source, whole: its original text, and when it was added. */
export interface SourceVersion extends SourceVersionRef {
  text: string;
  addedAt: Date;
}

/**
 * A model call the Brain's background work asks its host to make, through
 * the host's model gateway: what the call is for (`brain.<kind of work>`),
 * its instructions, its one message, and how long it may take: what is
 * left of its item's time, less a moment. The host cancels the call when
 * that is over, and says so (`timed_out`).
 */
export interface ModelRequest {
  purpose: string;
  system: string;
  input: string;
  timeoutMs: number;
}

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
 * What the host's model answered: its text; that it refused the call as it
 * is (`refused`: the request itself) or that the call ran out of its time
 * (`timed_out`), which fail the item; or that the queue must pause, why,
 * and for how many seconds where the provider said, with no item's attempt
 * spent. A call that throws instead is taken for the host out of reach.
 */
export const modelReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("answer"), text: z.string() }),
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
} as const;
export type WorkErrorCode = keyof typeof workErrors;

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

/** How many erasures of one kind are in the ledger, and how many not yet. */
export interface ErasureCount {
  written: number;
  unwritten: number;
}

/**
 * The erasures the store applied, as counts only: by kind, written to the
 * ledger or not yet, and by reason. Never which, when, or the SHA-256 the
 * ledger names one by: an unsalted hash of an id confirms to anyone
 * holding the id that it was erased.
 */
export interface ErasuresOverview {
  source: ErasureCount;
  person: ErasureCount;
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

/** The classes of work a hand-over may take (work.ts `workPriorities`). */
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
 * is closed, or its one reader's erasure began), the host's answer can't
 * be added (no readers, a text that isn't one), or its text is past a
 * source's bound with nothing smaller to keep.
 */
export const handOverRefusals = ["erased", "invalid", "too_large"] as const;
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
   * again (a store out of reach, an audit write that failed). Safe to
   * repeat.
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

/** A source to erase, every version of it, and why. */
export const sourceErasureSchema = z.strictObject({
  source: sourceIdSchema,
  reason: z.enum(erasureReasons),
});
export type SourceErasure = z.infer<typeof sourceErasureSchema>;

/** A person whose own content to erase, and why. */
export const personErasureSchema = z.strictObject({
  person: principalSchema,
  reason: z.enum(erasureReasons),
});
export type PersonErasure = z.infer<typeof personErasureSchema>;

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
   * wrote; abandoned once it took anything, or the ledger names what the
   * export holds.
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
// attribute never ends or contests another.
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
 * (`attribute` left out): it is kept and found, and never ends or
 * contests another.
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
    step: { values: "many" },
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

/** A memory's id: the store's own, for citing it and retiring it. */
export const memoryIdSchema = z.uuid();
export type MemoryId = z.infer<typeof memoryIdSchema>;

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

/** A short text a memory holds: some text, at most `max` characters. */
const someText = (max: number) =>
  wellFormedString().regex(/\S/u, { message: "Holds no text" }).max(max);

/**
 * A name of an entity: some text, at most `valueMaxLength` characters, and
 * no longer than that once folded as search folds it (`foldForSearch`:
 * compatibility forms such as "ﬃ" expand), so every name an add keeps
 * fits a `readEntityNames` cursor, which holds a name folded.
 */
const nameSchema = someText(valueMaxLength).refine(
  (name) => foldForSearch(name).length <= valueMaxLength,
  { message: `At most ${valueMaxLength} characters once folded` }
);

/**
 * An entity an add names, by a key of its own within the add (`key`,
 * which its memories use): the known entity `id`, or else one found by
 * its exact identifiers, the first entity of its kind holding any of
 * them (never by a name alone: linking on names and proposals are the
 * linker's), or else a new one. Its names and identifiers are kept as
 * given by each memory of the add that mentions it, so each is visible
 * only to those who can read such a memory.
 */
export const newEntitySchema = z.strictObject({
  key: wellFormedString().min(1).max(64),
  id: entityIdSchema.optional(),
  kind: z.enum(entityKinds),
  names: z.array(nameSchema).max(namesPerEntityMax).default([]),
  identifiers: z.array(identifierSchema).max(namesPerEntityMax).default([]),
});
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
 * source and version (one add per version); for `remember`, the writer
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

/**
 * One of the reader's own memories to retire: its lineage is the reader's
 * person, as writer, as `confirmMemory` takes its person from the reader.
 */
export const retireRequestSchema = z.strictObject({
  memory: memoryIdSchema,
  reader: readerSchema,
});
export type RetireRequest = z.infer<typeof retireRequestSchema>;

/** A memory the reader confirms, as their own word. */
export const confirmRequestSchema = z.strictObject({
  memory: memoryIdSchema,
  reader: readerSchema,
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
 * go on from.
 */
export interface EntityPage {
  entities: Entity[];
  more: boolean;
  next?: EntitiesCursor;
}

/** An entity to read, for a reader. */
export const entityRequestSchema = z.strictObject({
  entity: entityIdSchema,
  reader: readerSchema,
});
export type EntityRequest = z.infer<typeof entityRequestSchema>;

/**
 * An entity as a reader sees it: its kind, and its earliest name a memory
 * the reader may read gave (by when that memory was learned, then its
 * id), or null. Every name and identifier they may see is read a page at
 * a time (`readEntityNames`).
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
  addSource: (source: NewSource) => Promise<SourceVersionRef>;
  /**
   * Adds a version of an instruction file as `addSource` adds a source,
   * with the same versions, change keys and safe repeats, but kept whole:
   * never cut into chunks or indexed, so recall never returns it.
   */
  addInstructions: (source: NewInstructions) => Promise<SourceVersionRef>;
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
   * A version of a source, current or history, whole as it was added, for
   * a reader among that version's readers and the source's current
   * version's, with the groups the host counts them in now: `null` when
   * there is none or they may not, alike. So narrowing a source's readers
   * hides its history from those taken off.
   */
  readVersion: (request: VersionRequest) => Promise<SourceVersion | null>;
  /**
   * The current version of each source asked for, whole, in the order
   * asked, leaving out alike each that doesn't exist and each whose
   * current version the reader may not read.
   */
  readCurrent: (request: CurrentRequest) => Promise<SourceVersion[]>;
  /**
   * What this store has of the key `source`, whoever may read it: `erased`
   * when an erasure closed it, `held` when a version of it is kept
   * (current or history), `free` when it was never given it. For the host
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
   * an add to it is refused from then on. It answers alike whether the
   * source held anything, and is safe to repeat.
   */
  eraseSource: (request: SourceErasure) => Promise<void>;
  /**
   * Erases what only `person` may read, as `eraseSource` erases a source:
   * every version readable by them alone, added up to now, and whole each
   * source whose current version is such, and every memory readable by
   * them alone, learned up to now, at once. A source others read now keeps
   * their versions. Content added for them afterwards is new and kept.
   * Answers alike whatever they held, and is safe to repeat.
   */
  erasePerson: (request: PersonErasure) => Promise<void>;
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
   * change was added before with other memories. The same change again
   * answers what it added.
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
   * Retires one of the reader's own memories (its lineage is the reader's
   * person, as writer) that they may read and that is current for them: it
   * stops being current from now on, and stays as history. It no longer
   * ends older memories, which may become current again. One already retired
   * answers `done` again, so a retry never reads as not found; one ended
   * otherwise, expired included, answers `nothing`, as one not theirs.
   */
  retireMemory: (request: RetireRequest) => Promise<MemoryChangeOutcome>;
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
