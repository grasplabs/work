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

/** Most characters of a question. */
export const questionMaxLength = 2000;

/** Most groups a reader can be in. */
export const readerGroupsMax = 1000;

/** Most characters of a principal's ID. */
export const principalMaxLength = 256;

/** Most chunks one recall returns. */
export const recallLimit = 10;

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
    // Folding can grow a text many times (a compatibility form such as
    // "ﷺ" is 3 bytes, and 33 folded), so the bound holds for what the
    // word index takes too.
    .refine((text) => byteLengthOf(foldForSearch(text)) <= sourceTextMaxBytes, {
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

/** A recall: a question, in the reader's words, and the reader. */
export const recallRequestSchema = z.strictObject({
  question: wellFormedString().max(questionMaxLength),
  reader: readerSchema,
});
export type RecallRequest = z.infer<typeof recallRequestSchema>;

/** A version of a source, as an add records it. */
export interface SourceVersionRef {
  source: SourceId;
  version: number;
}

/** A chunk a recall found: a passage of a source's current version. */
export interface RecalledChunk extends SourceVersionRef {
  text: string;
}

/** What a recall found the reader may read, best first. */
export interface Recalled {
  chunks: RecalledChunk[];
}

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
   * The tick's own steps before its queue, each with its last failure
   * since the store started: the sweep of leftover files, cleared once a
   * later sweep reached R2 and had its answer (one with nothing due
   * clears nothing; sweeping waits a quarter of an hour after a failure),
   * and the repack of vector codes, cleared once a later tick's repack
   * finishes (tried again next tick).
   */
  stepsFailed: { sweep: StepFailure | null; repack: StepFailure | null };
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

/** Most dimensions of a vector. */
export const vectorDimensionsMax = 4096;

/** Most vectors one put takes. */
export const vectorsPerPutMax = 256;

/** Most chunks one vector search returns. */
export const vectorSearchLimitMax = 50;

/** Most characters of a model's name. */
export const modelNameMaxLength = 256;

const modelNameSchema = wellFormedString().min(1).max(modelNameMaxLength);

/** A vector: finite numbers, never all zero (it has no direction). */
const vectorSchema = z
  .array(z.number())
  .min(1)
  .max(vectorDimensionsMax)
  .refine((vector) => vector.some((value) => value !== 0), {
    message: "Is all zeros",
  });

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
      .array(z.strictObject({ chunk: chunkRefSchema, vector: vectorSchema }))
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
   * The chunks of current versions the reader may read that hold the
   * question's words in any of their forms, best first: those holding
   * more of them, then more of its commonest words (the stop words of
   * English, Dutch, German, French and Spanish), then more of them as
   * asked, then shorter, then newer. Chunks holding only its commonest
   * words come last, and only when the others are fewer than the limit.
   */
  recall: (request: RecallRequest) => Promise<Recalled>;
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
   * One tick of the host's clock, at `at`, the host's time now. First it
   * removes one batch of what adds that never finished left (files no
   * version holds, once past the time an add takes). Then it repacks a few
   * blocks of vector codes that hold removed ones. Then it works the
   * queue: runs what is due, a few at a time, asking `ask` for the model
   * calls it makes, and returns once what it started has ended and nothing
   * more is due, or its time to start more is up. `ask` is used only while
   * this call is open. A second tick at the same time shares the same
   * limits and claims nothing the first has under way.
   */
  work: (ask: AskModel, at: Date) => Promise<void>;
  /** The queue, as staff see it. */
  workOverview: () => Promise<WorkOverview>;
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
   * the store's own tick repacks a few blocks each time (`work`), and
   * erasure (GRA-1729) may run it too.
   */
  repackVectors: () => Promise<boolean>;
}

/** The one store's name: the Brain holds everything in one store for now. */
const storeName = "brain";

/**
 * The Brain, in `store`, the host's namespace of `BrainStore`, in the
 * jurisdiction the host keeps its objects in.
 */
export const brainOf = (store: DurableObjectNamespace<BrainStore>): Brain =>
  store.getByName(storeName);
